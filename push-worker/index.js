
const admin = require("firebase-admin");
const webpush = require("web-push");
const crypto = require("node:crypto");

// ==========================================
// CONFIGURATION
// ==========================================

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT || "{}"
);

const vapidPublicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
const vapidPrivateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();

// Rattrapage maximal : 3 heures
const REMINDER_CATCHUP_MINUTES = 180;

// Fuseau horaire
const TIME_ZONE = "Europe/Brussels";

// ==========================================
// VALIDATION
// ==========================================

if (
  !serviceAccount.project_id ||
  !serviceAccount.client_email ||
  !vapidPublicKey ||
  !vapidPrivateKey
) {
  throw new Error("Configuration Firebase ou VAPID manquante.");
}

if (!/^[A-Za-z0-9_-]{43}$/.test(vapidPrivateKey)) {
  throw new Error("Format de la clé privée VAPID invalide.");
}

console.log("Compte utilisé :", serviceAccount.client_email);
console.log("Projet utilisé :", serviceAccount.project_id);
console.log("Clé publique présente :", !!vapidPublicKey);
console.log("Clé privée présente :", !!vapidPrivateKey);

// Vérification de la paire VAPID
const ecdh = crypto.createECDH("prime256v1");
const privateBytes = Buffer.from(vapidPrivateKey, "base64url");

if (privateBytes.length !== 32) {
  throw new Error("Longueur de clé privée VAPID incorrecte.");
}

ecdh.setPrivateKey(privateBytes);

const derivedPublicKey = ecdh
  .getPublicKey(undefined, "uncompressed")
  .toString("base64url");

if (derivedPublicKey !== vapidPublicKey) {
  throw new Error("Les clés publiques et privées VAPID ne correspondent pas.");
}

// ==========================================
// INITIALISATION FIREBASE
// ==========================================

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

webpush.setVapidDetails(
  "mailto:duchenejerem@gmail.com",
  vapidPublicKey,
  vapidPrivateKey
);

const base = db.collection("pharmacieFamiliale").doc("inventaire");

const medicinesRef = base.collection("medicaments");
const devicesRef = base.collection("notificationDevices");
const logsRef = base.collection("notificationLog");

// ==========================================
// DATE ET HEURE
// ==========================================

function brusselsParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  return Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );
}

function addDays(dateString, amount) {
  const [y, m, d] = dateString.split("-").map(Number);

  const date = new Date(Date.UTC(y, m - 1, d + amount));

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function daysUntil(dateString, today) {
  if (
    typeof dateString !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dateString)
  ) {
    return null;
  }

  const [y, m, d] = dateString.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);

  return Math.round(
    (Date.UTC(y, m - 1, d) -
      Date.UTC(ty, tm - 1, td)) / 86400000
  );
}

function validTime(value) {
  return (
    typeof value === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
  );
}

// ==========================================
// CONSTRUCTION DES RAPPELS
// ==========================================

function eventsForMedicine(m, today, nowMinutes) {
  const events = [];

  console.log("Médicament :", m.name || m.id);

  // ----------------------------------------
  // RAPPELS DE PRISE
  // ----------------------------------------

  if (m.reminderOn === true) {
    const times = [];

    if (validTime(m.reminderTime)) {
      times.push(m.reminderTime);
    }

    if (m.reminderFreq === "Matin et soir") {
      const eveningTime = m.reminderEveningTime || "20:00";

      if (validTime(eveningTime)) {
        times.push(eveningTime);
      }
    }

    const yesterday = addDays(today, -1);

    for (const time of [...new Set(times)]) {
      const [hour, minute] = time.split(":").map(Number);

      const targetMinutes = hour * 60 + minute;

      let elapsed = nowMinutes - targetMinutes;
      let scheduledDate = today;

      // Gestion du passage à minuit
      if (elapsed < 0) {
        elapsed += 1440;
        scheduledDate = yesterday;
      }

      // Vérification de la fenêtre de rattrapage
      if (
        elapsed >= 0 &&
        elapsed <= REMINDER_CATCHUP_MINUTES
      ) {
        const key =
          `prise_${scheduledDate}_${time.replace(":", "")}`;

        events.push({
          key,
          title: "Ma Pharmacie — rappel de prise",
          body:
            `${m.name || "Médicament"}` +
            `${m.dose ? " · " + m.dose : ""}` +
            ` — ${m.person || "Famille"}`
        });

        console.log("RAPPEL DÉTECTÉ :", {
          medicament: m.name,
          heurePrévue: time,
          datePrévue: scheduledDate,
          retardMinutes: elapsed
        });
      }
    }
  }

  // ----------------------------------------
  // PÉREMPTION
  // ----------------------------------------

  if (m.expiry) {
    const remainingDays = daysUntil(m.expiry, today);

    if ([30, 7, 1, 0].includes(remainingDays)) {
      events.push({
        key: `peremption_${today}_${remainingDays}`,
        title: "Ma Pharmacie — péremption",
        body:
          remainingDays === 0
            ? `${m.name} arrive à péremption aujourd'hui.`
            : `${m.name} arrive à péremption dans ${remainingDays} jour(s).`
      });
    }
  }

  // ----------------------------------------
  // STOCK FAIBLE
  // ----------------------------------------

  const quantity = Number(m.quantity ?? 0);
  const threshold = Number(m.threshold ?? 0);

  if (quantity <= threshold) {
    events.push({
      key: `stock_${today}`,
      title: "Ma Pharmacie — stock faible",
      body:
        `Stock faible : ${m.name} (${quantity} restant(s)).`
    });
  }

  return events;
}

// ==========================================
// IDENTIFIANTS ET JOURNAL
// ==========================================

function makeId(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

// Réservation atomique pour éviter les doublons
async function claimNotification(logRef, data) {
  return db.runTransaction(async transaction => {
    const previous = await transaction.get(logRef);

    if (previous.exists) {
      return false;
    }

    transaction.create(logRef, {
      ...data,
      status: "sending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return true;
  });
}

function errorDetails(error) {
  let body = error && error.body;

  if (Buffer.isBuffer(body)) {
    body = body.toString("utf8");
  }

  if (typeof body !== "string") {
    try {
      body = body ? JSON.stringify(body) : "";
    } catch {
      body = String(body || "");
    }
  }

  return {
    code: error && error.code,
    status: error && error.statusCode,
    message: error && error.message,
    body: body || "(aucun détail)"
  };
}

// ==========================================
// ENVOI DES NOTIFICATIONS
// ==========================================

async function sendNotification(device, medicine, event) {
  const subscription =
    device.subscription || {
      endpoint: device.endpoint,
      keys: device.keys
    };

  if (
    !subscription.endpoint ||
    !subscription.keys?.p256dh ||
    !subscription.keys?.auth
  ) {
    console.warn("Abonnement incomplet :", device.id);
    return "invalid";
  }

  const logId = makeId(
    `${device.id}|${medicine.id}|${event.key}`
  );

  const logRef = logsRef.doc(logId);

  let claimed;

  try {
    claimed = await claimNotification(logRef, {
      medicineId: medicine.id,
      deviceId: device.id,
      eventKey: event.key
    });
  } catch (error) {
    console.error(
      "ERREUR réservation Firestore :",
      errorDetails(error)
    );

    return "firestore_error";
  }

  if (!claimed) {
    console.log("Déjà envoyé :", event.key);
    return "skipped";
  }

  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title: event.title,
        body: event.body,
        url: "./"
      })
    );

    console.log("NOTIFICATION ENVOYÉE :", {
      appareil: device.id,
      medicament: medicine.name,
      evenement: event.key
    });

    try {
      await logRef.update({
        status: "sent",
        sentAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error(
        "Push envoyé mais mise à jour du journal impossible :",
        errorDetails(error)
      );
    }

    return "sent";

  } catch (error) {
    console.error(
      "ERREUR PUSH :",
      {
        appareil: device.id,
        medicament: medicine.name,
        evenement: event.key,
        ...errorDetails(error)
      }
    );

    // Suppression de la réservation si l'envoi a échoué
    try {
      await logRef.delete();
    } catch (deleteError) {
      console.error(
        "Impossible de libérer la réservation :",
        errorDetails(deleteError)
      );
    }

    if (
      error.statusCode === 404 ||
      error.statusCode === 410
    ) {
      try {
        await devicesRef.doc(device.id).delete();
        console.log("Appareil expiré supprimé :", device.id);
      } catch (deleteError) {
        console.error(
          "Erreur suppression appareil :",
          errorDetails(deleteError)
        );
      }

      return "expired";
    }

    return "push_error";
  }
}

// ==========================================
// PROGRAMME PRINCIPAL
// ==========================================

async function main() {
  const p = brusselsParts();

  const today = `${p.year}-${p.month}-${p.day}`;

  const nowMinutes =
    Number(p.hour) * 60 + Number(p.minute);

  console.log("================================");
  console.log("MA PHARMACIE — WORKER");
  console.log("Date :", today);
  console.log("Heure :", `${p.hour}:${p.minute}`);
  console.log("Fuseau :", TIME_ZONE);
  console.log("Rattrapage :", REMINDER_CATCHUP_MINUTES, "minutes");
  console.log("================================");

  // Lecture des médicaments
  const medicineSnap = await medicinesRef.get();

  console.log(
    "Médicaments trouvés :",
    medicineSnap.size
  );

  // Lecture des appareils
  const deviceSnap = await devicesRef.get();

  console.log(
    "Appareils inscrits :",
    deviceSnap.size
  );

  if (deviceSnap.empty) {
    console.log("Aucun appareil inscrit.");
    return;
  }

  const devices = deviceSnap.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));

  const stats = {
    detected: 0,
    sent: 0,
    skipped: 0,
    pushErrors: 0,
    firestoreErrors: 0
  };

  // Parcours des médicaments
  for (const medicineDoc of medicineSnap.docs) {
    const medicine = {
      id: medicineDoc.id,
      ...medicineDoc.data()
    };

    const events = eventsForMedicine(
      medicine,
      today,
      nowMinutes
    );

    stats.detected += events.length;

    // Parcours des événements
    for (const event of events) {

      // Envoi vers chaque appareil
      for (const device of devices) {
        const result = await sendNotification(
          device,
          medicine,
          event
        );

        switch (result) {
          case "sent":
            stats.sent++;
            break;

          case "skipped":
            stats.skipped++;
            break;

          case "push_error":
          case "expired":
            stats.pushErrors++;
            break;

          case "firestore_error":
            stats.firestoreErrors++;
            break;
        }
      }
    }
  }

  // ========================================
  // BILAN FINAL
  // ========================================

  console.log("================================");
  console.log("BILAN FINAL MA PHARMACIE");
  console.log("Événements détectés :", stats.detected);
  console.log("Notifications envoyées :", stats.sent);
  console.log("Déjà enregistrées :", stats.skipped);
  console.log("Erreurs Push :", stats.pushErrors);
  console.log("Erreurs Firestore :", stats.firestoreErrors);
  console.log("================================");
}

// ==========================================
// DÉMARRAGE
// ==========================================

main().catch(error => {
  console.error(
    "ERREUR FATALE DU WORKER :",
    errorDetails(error)
  );

  process.exitCode = 1;
});
