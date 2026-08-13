self.addEventListener("push", event => {
  let data = {
    title: "Sharp Entry V3",
    body: "New XAUUSD signal detected",
    url: "/"
  };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {}
  }

  const options = {
    body: data.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: {
      url: data.url || "/"
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  event.waitUntil(
    clients.openWindow(event.notification.data.url || "/")
  );
});
