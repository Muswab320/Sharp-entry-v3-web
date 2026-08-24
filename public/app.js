const priceEl =
  document.getElementById("price");

const signalEl =
  document.getElementById("signal");

const confidenceEl =
  document.getElementById("confidence");

const reasonEl =
  document.getElementById("reason");

const lastScanEl =
  document.getElementById("lastScan");

const historyEl =
  document.getElementById("history");

const statusEl =
  document.getElementById("status");

const scanButton =
  document.getElementById("scanButton");

const notificationButton =
  document.getElementById(
    "notificationButton"
  );

const testNotificationButton =
  document.getElementById(
    "testNotificationButton"
  );


/* ==========================
   LOAD SERVER
========================== */

async function loadStatus() {
  try {
    const response =
      await fetch(
        "/api/status",
        {
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        "Server response failed"
      );
    }

    const data =
      await response.json();

    updateScreen(data);

  } catch (error) {

    console.log(
      "Status error:",
      error
    );

    if (statusEl) {
      statusEl.textContent =
        "Connection error";
    }
  }
}


/* ==========================
   UPDATE DISPLAY
========================== */

function updateScreen(data) {

  if (
    priceEl &&
    data.market
  ) {
    priceEl.textContent =
      data.market.price
        ? `$${data.market.price}`
        : "--";
  }


  const signal =
    data.signal || {};


  if (signalEl) {

    signalEl.textContent =
      signal.type || "WAIT";

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
  }


  if (confidenceEl) {
    confidenceEl.textContent =
      `${signal.confidence || 0}%`;
  }


  if (reasonEl) {
    reasonEl.textContent =
      signal.reason ||
      "Waiting for Sharp Entry confirmation";
  }


  if (lastScanEl) {

    if (data.lastScanAt) {

      lastScanEl.textContent =
        new Date(
          data.lastScanAt
        ).toLocaleString();

    } else {

      lastScanEl.textContent =
        "--";
    }
  }


  if (statusEl) {

    if (data.scanning) {

      statusEl.textContent =
        "Scanning market...";

    } else if (
      data.lastError
    ) {

      statusEl.textContent =
        data.lastError;

    } else {

      statusEl.textContent =
        "🟢 Sharp Entry Online";
    }
  }


  showHistory(
    data.history || []
  );
}


/* ==========================
   SIGNAL HISTORY
========================== */

function showHistory(history) {

  if (!historyEl) {
    return;
  }

  historyEl.innerHTML = "";


  if (
    !history ||
    history.length === 0
  ) {

    historyEl.innerHTML =
      `
      <div class="history-empty">
        No signals yet
      </div>
      `;

    return;
  }


  history.forEach(
    item => {

      const row =
        document.createElement(
          "div"
        );

      row.className =
        "history-item";


      row.innerHTML = `

        <div>

          <strong
            class="${item.type.toLowerCase()}"
          >
            ${item.type}
          </strong>

          <span>
            XAU/USD
          </span>

        </div>


        <div>
          Entry:
          ${item.entry}
        </div>


        <div>
          Confidence:
          ${item.confidence}%
        </div>


        <div>
          ${item.reason || ""}
        </div>


        <small>
          ${new Date(
            item.time
          ).toLocaleString()}
        </small>

      `;


      historyEl.appendChild(
        row
      );
    }
  );
}


/* ==========================
   MANUAL SCAN
========================== */

if (scanButton) {

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
              method: "POST"
            }
          );


        const data =
          await response.json();


        updateScreen(data);


      } catch (error) {

        if (statusEl) {
          statusEl.textContent =
            "Scan failed";
        }

      }


      scanButton.disabled =
        false;

      scanButton.textContent =
        "Scan Market";
    }
  );
}


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
        base64String.length % 4
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
        char.charCodeAt(0)
    )
  );
}


/* ==========================
   ENABLE NOTIFICATIONS
========================== */

async function enableNotifications() {

  try {

    if (
      !(
        "serviceWorker"
        in navigator
      )
    ) {

      alert(
        "Notifications are not supported."
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


    const keyResponse =
      await fetch(
        "/api/vapid-public-key"
      );


    const keyData =
      await keyResponse.json();


    if (
      !keyData.publicKey
    ) {

      alert(
        "Notification keys are not configured."
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
                keyData.publicKey
              )

          });
    }


    await fetch(
      "/api/subscribe",
      {

        method: "POST",

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
      "🔥 Sharp Entry notifications enabled."
    );


  } catch (error) {

    console.log(
      error
    );


    alert(
      "Notification error: " +
      error.message
    );
  }
}


if (notificationButton) {

  notificationButton
    .addEventListener(
      "click",
      enableNotifications
    );
}


/* ==========================
   TEST NOTIFICATION
========================== */

if (testNotificationButton) {

  testNotificationButton
    .addEventListener(
      "click",
      async () => {

        try {

          const response =
            await fetch(
              "/api/test-notification",
              {
                method: "POST"
              }
            );


          const data =
            await response.json();


          if (data.success) {

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
}


/* ==========================
   START APP
========================== */

loadStatus();


setInterval(
  loadStatus,
  15000
);
