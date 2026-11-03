const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

const db = getFirestore();
const tz = "Europe/Brussels";

const meds = db
  .collection("pharmacieFamiliale")
  .doc("inventaire")
  .collection("medicaments");

const devices = db
  .collection("pharmacieFamiliale")
  .doc("inventaire")
  .collection("notificationDevices");

function nowParts() {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(new Date())
      .map(x => [x.type, x.value])
  );
}

function daysTo(date, today) {
  if (!date) return null;

  const [y, m, d] = date.split("-").map(Number);

  return Math.round(
    (
      Date.UTC(y, m - 1, d) -
      Date.UTC(+today.year, +today.month - 1, +today.day)
    ) / 86400000
  );
}

async function send(title, body, data) {
  const snap = await devices.get();

  const tokens = [
    ...new Set(
      snap.docs.map(d => d.get("token")).filter(Boolean)
    )
  ];

  if (!tokens.length) return;

  const result = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
    webpush: {
      fcmOptions: {
        link: "https://dplayvision.github.io/"
      }
    }
  });

  const batch = db.batch();
  let dirty = false;

  result.responses.forEach((response, i) => {
    if (
      !response.success &&
      [
        "messaging/registration-token-not-registered",
        "messaging/invalid-registration-token"
      ].includes(response.error?.code)
    ) {
      const device = snap.docs.find(
        d => d.get("token") === tokens[i]
      );

      if (device) {
        batch.delete(device.ref);
        dirty = true;
      }
    }
  });

  if (dirty) await batch.commit();
}

exports.pharmacyNotifications = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: tz,
    region: "europe-west1"
  },
  async () => {
    const p = nowParts();
    const date = `${p.year}-${p.month}-${p.day}`;
    const clock = `${p.hour}:${p.minute}`;

    const snap = await meds.get();

    for (const d of snap.docs) {
      const m = d.data();
      const ref = d.ref;

      // Rappels de prise
      if (m.reminderOn) {
        const times = [m.reminderTime];

        if (m.reminderFreq === "Matin et soir") {
          times.push(m.reminderEveningTime || "20:00");
        }

        const key = `${date}_${clock}`;

        if (
          times.includes(clock) &&
          m.lastReminderMinuteKey !== key
        ) {
          await send(
            "Ma Pharmacie — rappel de prise",
            `${m.name || "Médicament"}${m.dose ? " · " + m.dose : ""} — ${m.person || "Famille"}`,
            { type: "medication", medicineId: d.id }
          );

          await ref.update({
            lastReminderMinuteKey: key
          });
        }
      }

      // Dates de péremption
      if (m.expiry) {
        const n = daysTo(m.expiry, p);
        const key = `${date}_${n}`;

        if (
          [30, 7, 1, 0].includes(n) &&
          m.lastExpiryNoticeKey !== key
        ) {
          await send(
            "Ma Pharmacie — péremption",
            n === 0
              ? `${m.name} arrive à péremption aujourd'hui.`
              : `${m.name} arrive à péremption dans ${n} jour(s).`,
            { type: "expiry", medicineId: d.id }
          );

          await ref.update({
            lastExpiryNoticeKey: key
          });
        }
      }

      // Stock faible
      if (
        +m.quantity <= +(m.threshold ?? 0) &&
        m.lastLowStockNoticeDate !== date
      ) {
        await send(
          "Ma Pharmacie — stock faible",
          `Stock faible : ${m.name} (${+m.quantity || 0} restant(s)).`,
          { type: "stock", medicineId: d.id }
        );

        await ref.update({
          lastLowStockNoticeDate: date
        });
      }
    }
  }
);
