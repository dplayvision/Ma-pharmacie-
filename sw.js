self.addEventListener("push", event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: "Ma Pharmacie",
      body: event.data ? event.data.text() : "Vous avez une alerte."
    };
  }

  event.waitUntil(
    self.registration.showNotification(
      data.title || "Ma Pharmacie",
      {
        body: data.body || "Vous avez une nouvelle alerte.",
        icon: "./icon-192.png",
        badge: "./icon-192.png",
        data: { url: data.url || "./" }
      }
    )
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  const target = new URL(
    event.notification.data?.url || "./",
    self.location.origin
  ).href;

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then(async windows => {
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin)) {
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(target);
      }
    })
  );
});
