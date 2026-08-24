const priceEl =
  document.getElementById(
    "price"
  );

const signalEl =
  document.getElementById(
    "signal"
  );

const confidenceEl =
  document.getElementById(
    "confidence"
  );

const reasonEl =
  document.getElementById(
    "reason"
  );

const supportEl =
  document.getElementById(
    "support"
  );

const resistanceEl =
  document.getElementById(
    "resistance"
  );

const lastScanEl =
  document.getElementById(
    "lastScan"
  );

const historyEl =
  document.getElementById(
    "history"
  );

const statusEl =
  document.getElementById(
    "status"
  );

const scanButton =
  document.getElementById(
    "scanButton"
  );

const notificationButton =
  document.getElementById(
    "notificationButton"
  );

const testNotificationButton =
  document.getElementById(
    "testNotificationButton"
  );

/* ==========================
   LOAD SERVER STATUS
========================== */

async function loadStatus() {
  try {
    const response =
      await fetch(
        "/api/status"
      );

    const data =
      await response.json();

    updateScreen(data);
  } catch (error) {
    statusEl.textContent =
      "Cannot connect to server";
  }
}

/* ==========================
   UPDATE SCREEN
========================== */

function updateScreen(data) {
  if (
    data.market &&
    data.market.price
  ) {
    priceEl.textContent =
      `$${data.market.price}`;
  } else {
    priceEl.textContent =
      "--";
  }

  const signal =
    data.signal || {};

  signalEl.textContent =
    signal.type ||
    "WAIT";

  confidenceEl.textContent =
    `${signal.confidence || 0}%`;

  reasonEl.textContent =
    signal.reason ||
    "Waiting for Sharp Entry setup";

  supportEl.textContent =
    signal.support ||
    "--";

  resistanceEl.textContent =
    signal.resistance ||
    "--";

  if (
    signal.type === "BUY"
  ) {
    signalEl.className =
      "signal buy";
  } else if (
    signal.type === "SELL"
  ) {
    signalEl.className =
      "signal sell";
  } else {
    signalEl.className =
      "signal wait";
  }

  if (
    data.lastScanAt
  ) {
    lastScanEl.textContent =
      new Date(
        data.lastScanAt
      ).toLocaleString();
  } else {
    lastScanEl.textContent =
      "Not scanned yet";
  }

  if (
    data.scanning
  ) {
    statusEl.textContent =
      "Scanning Gold...";
  } else if (
    data.lastError
  ) {
    statusEl.textContent =
      data.lastError;
  } else {
    statusEl.textContent =
      "Sharp Entry scanner running";
  }

  showHistory(
    data.history || []
  );
}

/* ==========================
   HISTORY
========================== */

function showHistory(history) {
  historyEl.innerHTML = "";

  if (!history.length) {
    historyEl.innerHTML =
      `
      <div class="empty">
        No Sharp Entry signals yet
      </div>
      `;

    return;
  }

  history.forEach(
    item => {
      const card =
        document.createElement(
          "div"
        );

      card.className =
        "history-item";

      card.innerHTML = `
        <div class="history-top">

          <strong
            class="${item.type.toLowerCase()}"
          >
            ${item.type}
          </strong>

          <span>
            ${item.confidence}%
          </span>

        </div>

        <div>
          XAU/USD
        </div>

        <div>
          Entry:
          ${item.entry}
        </div>

        <div class="history-reason">
          ${item.reason}
        </div>

        <small>
          ${new Date(
            item.time
          ).toLocaleString()}
        </small>
      `;

      historyEl.appendChild(
        card
      );
    }
  );
}

/* ==========================
   MANUAL SCAN
========================== */

scanButton.addEventListener(
  "click",
  async () => {
    scanButton.disabled =
      true;

    scanButton.textContent =
      "Scanning...";

    try {
      const response =
        await fetch(
          "/api/scan",
          {
            method:
              "POST"
          }
        );

      const data =
        await response.json();

      updateScreen(data);
    } catch (error) {
      statusEl.textContent =
        "Scan failed";
    }

    scanButton.disabled =
      false;

    scanButton.textContent =
      "Scan Gold Now";
  }
);

/* ==========================
   PUSH NOTIFICATIONS
========================== */

function urlBase64ToUint8Array(
  base64String
) {
  const padding =
    "=".repeat(
      (
        4 -
        (
          base64String.length %
          4
        )
      ) % 4
    );

  const base64 =
    (
      base64String +
      padding
    )
      .replace(
        /-/g,
        "+"
      )
      .replace(
        /_/g,
        "/"
      );

  const rawData =
    window.atob(
      base64
    );

  return Uint8Array.from(
    [...rawData].map(
      char =>
        char.charCodeAt(
          0
        )
    )
  );
}

async function enableNotifications() {
  try {
    if (
      !(
        "serviceWorker"
        in navigator
      )
    ) {
      alert(
        "Notifications are not supported on this browser."
      );

      return;
    }

    const permission =
      await Notification
        .requestPermission();

    if (
      permission !==
      "granted"
    ) {
      alert(
        "Notification permission was not allowed."
      );

      return;
    }

    const registration =
      await navigator
        .serviceWorker
        .register(
          "/sw.js"
        );

    const response =
      await fetch(
        "/api/vapid-public-key"
      );

    const data =
      await response.json();

    if (
      !data.publicKey
    ) {
      alert(
        "Push notification keys are missing on the server."
      );

      return;
    }

    let subscription =
      await registration
        .pushManager
        .getSubscription();

    if (!subscription) {
      subscription =
        await registration
          .pushManager
          .subscribe({
            userVisibleOnly:
              true,

            applicationServerKey:
              urlBase64ToUint8Array(
                data.publicKey
              )
          });
    }

    await fetch(
      "/api/subscribe",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(
            subscription
          )
      }
    );

    alert(
      "Sharp Entry notifications enabled."
    );
  } catch (error) {
    alert(
      "Notification error: " +
      error.message
    );
  }
}

notificationButton
  .addEventListener(
    "click",
    enableNotifications
  );

/* ==========================
   TEST PUSH
========================== */

testNotificationButton
  .addEventListener(
    "click",
    async () => {
      try {
        const response =
          await fetch(
            "/api/test-notification",
            {
              method:
                "POST"
            }
          );

        const data =
          await response.json();

        if (
          data.success
        ) {
          alert(
            "Test notification sent."
          );
        }
      } catch (error) {
        alert(
          "Test notification failed."
        );
      }
    }
  );

/* ==========================
   START
========================== */

loadStatus();

setInterval(
  loadStatus,
  15000
);
