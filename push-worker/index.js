const admin = require("firebase-admin");
const webpush = require("web-push");
const crypto = require("node:crypto");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
console.log("Compte utilisé :", serviceAccount.client_email);
console.log("Projet utilisé :", serviceAccount.project_id);

const vapidPublicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
const vapidPrivateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();

console.log("Clé publique présente :", vapidPublicKey.length > 0);
console.log("Longueur clé publique :", vapidPublicKey.length);
console.log("Clé privée présente :", vapidPrivateKey.length > 0);
console.log("Longueur clé privée :", vapidPrivateKey.length);
console.log("Format privé valide :", /^[A-Za-z0-9_-]{43}$/.test(vapidPrivateKey));

// Vérifie la paire VAPID avec ECDH P-256. N'affiche jamais les clés.
try {
  const ecdh = crypto.createECDH("prime256v1");
  const privateBytes = Buffer.from(vapidPrivateKey, "base64url");
  if (privateBytes.length !== 32) {
    throw new Error("La clé privée décodée ne fait pas 32 octets.");
  }
  ecdh.setPrivateKey(privateBytes);
  const derivedPublicKey = ecdh.getPublicKey(undefined, "uncompressed").toString("base64url");
  console.log(
    "Clé publique et privée correspondantes :",
    derivedPublicKey === vapidPublicKey
  );
} catch (keyCheckError) {
  console.log("Vérification de paire impossible :", keyCheckError.message);
}

if (!serviceAccount.project_id || !vapidPublicKey || !vapidPrivateKey) {
  throw new Error("Secrets Firebase ou VAPID manquants.");
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

webpush.setVapidDetails("mailto:duchenejerem@gmail.com", vapidPublicKey, vapidPrivateKey);

const base = db.collection("pharmacieFamiliale").doc("inventaire");
const medicinesRef = base.collection("medicaments");
const devicesRef = base.collection("notificationDevices");
const logsRef = base.collection("notificationLog");

function brusselsParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Brussels", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function daysUntil(dateString, today) {
  if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;
  const [y, m, d] = dateString.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
}

function eventsForMedicine(m, today, nowMinutes) {
  const events = [];
  if (m.reminderOn) {
    const times = [m.reminderTime].filter(Boolean);
    if (m.reminderFreq === "Matin et soir") times.push(m.reminderEveningTime || "20:00");
    for (const time of [...new Set(times)]) {
      const [h, min] = time.split(":").map(Number);
      const elapsed = nowMinutes - (h * 60 + min);
      if (elapsed >= 0 && elapsed <= 10) {
        events.push({
          key: `prise_${today}_${time.replace(":", "")}`,
          title: "Ma Pharmacie — rappel de prise",
          body: `${m.name || "Médicament"}${m.dose ? " · " + m.dose : ""} — ${m.person || "Famille"}`
        });
      }
    }
  }
  if (m.expiry) {
    const n = daysUntil(m.expiry, today);
    if ([30, 7, 1, 0].includes(n)) {
      events.push({
        key: `peremption_${today}_${n}`,
        title: "Ma Pharmacie — péremption",
        body: n === 0 ? `${m.name} arrive à péremption aujourd'hui.` : `${m.name} arrive à péremption dans ${n} jour(s).`
      });
    }
  }
  if (Number(m.quantity ?? 0) <= Number(m.threshold ?? 0)) {
    events.push({
      key: `stock_${today}`,
      title: "Ma Pharmacie — stock faible",
      body: `Stock faible : ${m.name} (${Number(m.quantity ?? 0)} restant(s)).`
    });
  }
  return events;
}

function makeId(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function errorDetails(error) {
  let body = error && error.body;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body !== "string") {
    try { body = body ? JSON.stringify(body) : ""; }
    catch { body = String(body || ""); }
  }
  return {
    status: error && error.statusCode,
    message: error && error.message,
    body: body || "(aucun détail fourni par le serveur push)"
  };
}

async function main() {
  const p = brusselsParts();
  const today = `${p.year}-${p.month}-${p.day}`;
  const nowMinutes = Number(p.hour) * 60 + Number(p.minute);

  let medicineSnap, deviceSnap;
  try {
    console.log("Lecture de la collection medicaments...");
    medicineSnap = await medicinesRef.get();
    console.log("Medicaments OK :", medicineSnap.size);
  } catch (error) {
    console.error("ERREUR MEDICAMENTS :", error.code, error.message);
    throw error;
  }

  try {
    console.log("Lecture de la collection notificationDevices...");
    deviceSnap = await devicesRef.get();
    console.log("NotificationDevices OK :", deviceSnap.size);
  } catch (error) {
    console.error("ERREUR NOTIFICATIONDEVICES :", error.code, error.message);
    throw error;
  }

  const devices = deviceSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!devices.length) {
    console.log("Aucun téléphone inscrit.");
    return;
  }

  let sent = 0, skipped = 0;
  for (const medicineDoc of medicineSnap.docs) {
    const medicine = { id: medicineDoc.id, ...medicineDoc.data() };
    const events = eventsForMedicine(medicine, today, nowMinutes);
    for (const event of events) {
      for (const device of devices) {
        const subscription = device.subscription || { endpoint: device.endpoint, keys: device.keys };
        if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
          console.warn("Abonnement incomplet pour le téléphone :", device.id);
          continue;
        }

        const logId = makeId(`${device.id}|${medicine.id}|${event.key}`);
        const logRef = logsRef.doc(logId);
        const previous = await logRef.get();
        if (previous.exists) {
          skipped++;
          continue;
        }

        try {
          await webpush.sendNotification(subscription, JSON.stringify({
            title: event.title, body: event.body, url: "./"
          }));
          await logRef.set({
            medicineId: medicine.id,
            deviceId: device.id,
            eventKey: event.key,
            sentAt: admin.firestore.FieldValue.serverTimestamp()
          });
          sent++;
        } catch (error) {
          console.error("ERREUR PUSH DETAILLEE :", JSON.stringify(errorDetails(error)));
          if (error.statusCode === 404 || error.statusCode === 410) {
            await devicesRef.doc(device.id).delete().catch(() => {});
          }
        }
      }
    }
  }
  console.log(`Notifications envoyées : ${sent}`);
  console.log(`Déjà envoyées : ${skipped}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
