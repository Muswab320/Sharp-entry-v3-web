self.addEventListener(
  "push",
  event => {
    let data = {
      title: "🔥 Sharp Entry",
      body: "New Gold signal"
    };

    try {
      if (event.data) {
        data =
          event.data.json();
      }
    } catch (error) {
      console.log(
        "Push data error"
      );
    }

    event.waitUntil(
      self.registration
        .showNotification(
          data.title ||
            "🔥 Sharp Entry",
          {
            body:
              data.body ||
              "New XAU/USD signal",

            icon:
              "/icon-192.png",

            badge:
              "/icon-192.png",

            vibrate:
              [200, 100, 200],

            data: {
              url: "/"
            }
          }
        )
    );
  }
);

self.addEventListener(
  "notificationclick",
  event => {
    event.notification
      .close();

    event.waitUntil(
      clients.matchAll({
        type: "window",
        includeUncontrolled:
          true
      })
      .then(
        clientList => {
          for (
            const client
            of clientList
          ) {
            if (
              "focus"
              in client
            ) {
              return client
                .focus();
            }
          }

          if (
            clients.openWindow
          ) {
            return clients
              .openWindow("/");
          }
        }
      )
    );
  }
);
