const admin = require('firebase-admin');
const webpush = require('web-push');
const crypto = require('node:crypto');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
const vapidPublicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
const vapidPrivateKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
const TIME_ZONE = 'Europe/Brussels';
const REMINDER_CATCHUP_MINUTES = 180;
const STOCK_CATCHUP_MINUTES = 15;
const DEFAULT_STOCK_TIME = '09:00';

if (!serviceAccount.project_id || !serviceAccount.client_email || !vapidPublicKey || !vapidPrivateKey) {
  throw new Error('Configuration Firebase ou VAPID manquante.');
}
if (!/^[A-Za-z0-9_-]{43}$/.test(vapidPrivateKey)) throw new Error('Format de la clé privée VAPID invalide.');
const ecdh = crypto.createECDH('prime256v1');
const privateBytes = Buffer.from(vapidPrivateKey, 'base64url');
if (privateBytes.length !== 32) throw new Error('Longueur de clé privée VAPID incorrecte.');
ecdh.setPrivateKey(privateBytes);
if (ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url') !== vapidPublicKey) {
  throw new Error('Les clés publiques et privées VAPID ne correspondent pas.');
}
admin.initializeApp({credential: admin.credential.cert(serviceAccount)});
const db = admin.firestore();
webpush.setVapidDetails('mailto:duchenejerem@gmail.com', vapidPublicKey, vapidPrivateKey);
const base = db.collection('pharmacieFamiliale').doc('inventaire');
const medicinesRef = base.collection('medicaments');
const devicesRef = base.collection('notificationDevices');
const logsRef = base.collection('notificationLog');

function brusselsParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(p => [p.type, p.value]));
}
function addDays(iso, n) {
  const [y,m,d] = iso.split('-').map(Number);
  const x = new Date(Date.UTC(y,m-1,d+n));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth()+1).padStart(2,'0')}-${String(x.getUTCDate()).padStart(2,'0')}`;
}
function daysUntil(iso, today) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y,m,d] = iso.split('-').map(Number);
  const [a,b,c] = today.split('-').map(Number);
  return Math.round((Date.UTC(y,m-1,d)-Date.UTC(a,b-1,c))/86400000);
}
const validTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const minuteOf = s => { const [h,m] = s.split(':').map(Number); return h*60+m; };
function dueSlot(time, today, nowMinutes, catchup) {
  if (!validTime(time)) return null;
  let elapsed = nowMinutes - minuteOf(time);
  let date = today;
  if (elapsed < 0) { elapsed += 1440; date = addDays(today,-1); }
  return elapsed >= 0 && elapsed <= catchup ? {date, elapsed} : null;
}
function dailyUse(m) {
  return (Number(m.doseMorning)||0)+(Number(m.doseNoon)||0)+(Number(m.doseEvening)||0);
}
function currentStock(m, today) {
  const base = Number(m.stockBaseQuantity ?? m.quantity) || 0;
  const elapsed = m.stockUpdatedDate ? Math.max(0,-(daysUntil(m.stockUpdatedDate,today) ?? 0)) : 0;
  return Math.max(0,base-elapsed*dailyUse(m));
}
function medicineEvents(m,today,nowMinutes) {
  const events = [];
  if (m.reminderOn === true) {
    const times = [m.reminderTime];
    if (m.reminderFreq === 'Matin et soir') times.push(m.reminderEveningTime || '20:00');
    for (const time of new Set(times.filter(validTime))) {
      const slot = dueSlot(time,today,nowMinutes,REMINDER_CATCHUP_MINUTES);
      if (!slot) continue;
      // Respecter les dates de début et de fin, y compris après minuit.
      if (m.reminderStartDate && slot.date < m.reminderStartDate) continue;
      if (m.reminderEndDate && slot.date > m.reminderEndDate) continue;
      events.push({type:'reminder',key:`prise_${slot.date}_${time.replace(':','')}`,
        title:'Ma Pharmacie — rappel de prise',
        body:`${m.name||'Médicament'}${m.dose?' · '+m.dose:''} — ${m.person||'Famille'}`});
    }
  }
  if (m.expiry) {
    const n = daysUntil(m.expiry,today);
    if ([30,7,1,0].includes(n)) events.push({type:'expiry',key:`peremption_${today}_${n}`,
      title:'Ma Pharmacie — péremption',
      body:n===0?`${m.name} arrive à péremption aujourd'hui.`:`${m.name} arrive à péremption dans ${n} jour(s).`});
  }
  return events;
}
function stockEventForDevice(m,device,today,nowMinutes) {
  const time = validTime(device.lowStockTime) ? device.lowStockTime : DEFAULT_STOCK_TIME;
  const slot = dueSlot(time,today,nowMinutes,STOCK_CATCHUP_MINUTES);
  if (!slot) return null;
  const quantity = currentStock(m,slot.date);
  if (quantity > Number(m.threshold ?? 0)) return null;
  return {type:'stock',key:`stock_${slot.date}`,title:'Ma Pharmacie — stock faible',
    body:`Stock faible : ${m.name} (${quantity} restant(s)).`};
}
const makeId = s => crypto.createHash('sha256').update(s).digest('hex');
async function claimNotification(ref,data) {
  return db.runTransaction(async tx => {
    const old = await tx.get(ref);
    if (old.exists) return false;
    tx.create(ref,{...data,status:'sending',createdAt:admin.firestore.FieldValue.serverTimestamp()});
    return true;
  });
}
function errorDetails(e) {
  let body=e?.body;
  if (Buffer.isBuffer(body)) body=body.toString('utf8');
  if (typeof body!=='string') {try{body=body?JSON.stringify(body):'';}catch{body=String(body||'');}}
  return {code:e?.code,status:e?.statusCode,message:e?.message,body:body||'(aucun détail)'};
}
function deviceCanReceiveReminder(device,medicine) {
  const person = medicine.person || 'Famille';
  const profile = device.devicePerson || '';
  if (['Famille','Enzo','Lena'].includes(person)) return true;
  return ['Jérémy','Melissa'].includes(profile) && person === profile;
}

async function sendNotification(device,medicine,event) {
  const subscription=device.subscription || {endpoint:device.endpoint,keys:device.keys};
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    console.warn('Abonnement incomplet :',device.id);return 'invalid';
  }
  const logRef=logsRef.doc(makeId(`${device.id}|${medicine.id}|${event.key}`));
  let claimed;
  try {claimed=await claimNotification(logRef,{medicineId:medicine.id,deviceId:device.id,eventKey:event.key});}
  catch(e){console.error('Erreur réservation Firestore',errorDetails(e));return 'firestore_error';}
  if (!claimed) return 'skipped';
  try {
    await webpush.sendNotification(subscription,JSON.stringify({
      title:event.title,body:event.body,
      url:`./?openMed=${encodeURIComponent(medicine.id)}`,
      medicationId:medicine.id
    }));
    console.log('NOTIFICATION ENVOYÉE',device.id,medicine.name,event.key);
    try {await logRef.update({status:'sent',sentAt:admin.firestore.FieldValue.serverTimestamp()});}
    catch(e){console.error('Push envoyé, journal non mis à jour',errorDetails(e));}
    return 'sent';
  } catch(e) {
    console.error('ERREUR PUSH',device.id,medicine.name,event.key,errorDetails(e));
    try {await logRef.delete();}catch(err){console.error('Libération impossible',errorDetails(err));}
    if (e.statusCode===404 || e.statusCode===410) {
      try {await devicesRef.doc(device.id).delete();}catch(err){console.error('Suppression appareil impossible',errorDetails(err));}
      return 'expired';
    }
    return 'push_error';
  }
}
async function main() {
  const p=brusselsParts();
  const today=`${p.year}-${p.month}-${p.day}`;
  const nowMinutes=Number(p.hour)*60+Number(p.minute);
  console.log('MA PHARMACIE — WORKER',today,`${p.hour}:${p.minute}`,TIME_ZONE);
  const [medicineSnap,deviceSnap]=await Promise.all([medicinesRef.get(),devicesRef.get()]);
  console.log('Médicaments trouvés :',medicineSnap.size,'Appareils inscrits :',deviceSnap.size);
  if (deviceSnap.empty) return;
  const devices=deviceSnap.docs.map(d=>({id:d.id,...d.data()}));
  const stats={detected:0,sent:0,skipped:0,pushErrors:0,firestoreErrors:0,invalid:0};
  for (const d of medicineSnap.docs) {
    const medicine={id:d.id,...d.data()};
    const common=medicineEvents(medicine,today,nowMinutes);
    for (const device of devices) {
      const stock=stockEventForDevice(medicine,device,today,nowMinutes);
      // Seuls les rappels de prise personnels sont ciblés. Péremption et stock vont aux deux GSM.
      const eligibleCommon=common.filter(event =>
        event.type !== 'reminder' || deviceCanReceiveReminder(device,medicine)
      );
      const events=stock?[...eligibleCommon,stock]:eligibleCommon;
      for (const event of events) {
        stats.detected++;
        const result=await sendNotification(device,medicine,event);
        if (result==='sent') stats.sent++;
        else if (result==='skipped') stats.skipped++;
        else if (result==='firestore_error') stats.firestoreErrors++;
        else if (result==='invalid') stats.invalid++;
        else stats.pushErrors++;
      }
    }
  }
  console.log('BILAN FINAL',stats);
}
main().catch(e=>{console.error('ERREUR FATALE DU WORKER',errorDetails(e));process.exitCode=1;});
