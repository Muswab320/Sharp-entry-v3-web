self.addEventListener(
  "push",
  event => {
    let data = {};

    try {
      data = event.data
        ? event.data.json()
        : {};
    } catch {
      data = {};
    }

    const title =
      data.title ||
      "Sharp Entry V3";

    const options = {
      body:
        data.body ||
        "New Sharp Entry signal available.",

      icon:
        "/icon-192.png",

      badge:
        "/icon-192.png",

      data: {
        url:
          data.url || "/"
      }
    };

    event.waitUntil(
      self.registration
        .showNotification(
          title,
          options
        )
    );
  }
);

self.addEventListener(
  "notificationclick",
  event => {
    event.notification.close();

    const url =
      event.notification.data?.url ||
      "/";

    event.waitUntil(
      clients.matchAll({
        type: "window",
        includeUncontrolled: true
      })
      .then(windowClients => {

        for (
          const client
          of windowClients
        ) {
          if (
            "focus" in client
          ) {
            client.navigate(url);
            return client.focus();
          }
        }

        if (
          clients.openWindow
        ) {
          return clients
            .openWindow(url);
        }

      })
    );
  }
);
