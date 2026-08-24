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

const confidenceBar =
  document.getElementById(
    "confidenceBar"
  );

const entryEl =
  document.getElementById(
    "entry"
  );

const slEl =
  document.getElementById(
    "sl"
  );

const tp1El =
  document.getElementById(
    "tp1"
  );

const tp2El =
  document.getElementById(
    "tp2"
  );

const tp3El =
  document.getElementById(
    "tp3"
  );

const reasonEl =
  document.getElementById(
    "reason"
  );

const h1BiasEl =
  document.getElementById(
    "h1Bias"
  );

const m30BiasEl =
  document.getElementById(
    "m30Bias"
  );

const m15SetupEl =
  document.getElementById(
    "m15Setup"
  );

const m5EntryEl =
  document.getElementById(
    "m5Entry"
  );

const statusEl =
  document.getElementById(
    "status"
  );

const onlineStatusEl =
  document.getElementById(
    "onlineStatus"
  );

const lastScanEl =
  document.getElementById(
    "lastScan"
  );

const historyEl =
  document.getElementById(
    "history"
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


/* ==============================
   PRICE FORMAT
================================ */

function displayPrice(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return "--";

  }

  const number =
    Number(value);

  if (
    Number.isNaN(number)
  ) {

    return "--";

  }

  return number.toFixed(2);

}


/* ==============================
   COLOR TIMEFRAME
================================ */

function setDirection(
  element,
  value
) {

  if (!element) {
    return;
  }

  element.textContent =
    value || "WAIT";

  element.classList.remove(
    "bullish",
    "bearish",
    "neutral"
  );

  const text =
    String(
      value || ""
    ).toUpperCase();

  if (
    text.includes(
      "BULL"
    ) ||
    text.includes(
      "BUY"
    )
  ) {

    element.classList.add(
      "bullish"
    );

  } else if (
    text.includes(
      "BEAR"
    ) ||
    text.includes(
      "SELL"
    )
  ) {

    element.classList.add(
      "bearish"
    );

  } else {

    element.classList.add(
      "neutral"
    );

  }

}


/* ==============================
   LOAD STATUS
================================ */

async function loadStatus() {

  try {

    const response =
      await fetch(
        "/api/status",
        {
          cache:
            "no-store"
        }
      );

    if (
      !response.ok
    ) {

      throw new Error(
        "Server returned " +
        response.status
      );

    }

    const data =
      await response.json();

    updateScreen(data);

    if (
      onlineStatusEl
    ) {

      onlineStatusEl.textContent =
        "● ONLINE";

    }

  } catch (error) {

    console.log(
      "Server error:",
      error
    );

    if (statusEl) {

      statusEl.textContent =
        "Cannot connect to server";

    }

    if (
      onlineStatusEl
    ) {

      onlineStatusEl.textContent =
        "● OFFLINE";

    }

  }

}


/* ==============================
   UPDATE SCREEN
================================ */

function updateScreen(data) {

  const market =
    data.market || {};

  const signal =
    data.signal || {};

  const tf =
    data.timeframes || {};


  /* PRICE */

  if (priceEl) {

    priceEl.textContent =
      market.price !==
        null &&
      market.price !==
        undefined
        ? "$" +
          displayPrice(
            market.price
          )
        : "--";

  }


  /* SIGNAL */

  const signalType =
    signal.type ||
    "WAIT";

  if (signalEl) {

    signalEl.textContent =
      signalType;

    signalEl.className =
      "signal";

    if (
      signalType ===
      "BUY"
    ) {

      signalEl.classList.add(
        "buy"
      );

    } else if (
      signalType ===
      "SELL"
    ) {

      signalEl.classList.add(
        "sell"
      );

    } else {

      signalEl.classList.add(
        "wait"
      );

    }

  }


  /* CONFIDENCE */

  const confidence =
    Math.max(
      0,
      Math.min(
        100,
        Number(
          signal.confidence ||
          0
        )
      )
    );

  if (
    confidenceEl
  ) {

    confidenceEl.textContent =
      confidence + "%";

  }

  if (
    confidenceBar
  ) {

    confidenceBar.style.width =
      confidence + "%";

  }


  /* ENTRY / SL / TPS */

  if (entryEl) {

    entryEl.textContent =
      displayPrice(
        signal.entry
      );

  }

  if (slEl) {

    slEl.textContent =
      displayPrice(
        signal.sl
      );

  }

  if (tp1El) {

    tp1El.textContent =
      displayPrice(
        signal.tp1
      );

  }

  if (tp2El) {

    tp2El.textContent =
      displayPrice(
        signal.tp2
      );

  }

  if (tp3El) {

    tp3El.textContent =
      displayPrice(
        signal.tp3
      );

  }


  /* REASON */

  if (reasonEl) {

    reasonEl.textContent =
      signal.reason ||
      "Waiting for ICT confirmation";

  }


  /* ==========================
     H1
  ========================== */

  const h1 =
    tf.H1 || {};

  setDirection(
    h1BiasEl,
    h1.bias ||
    "WAIT"
  );


  /* ==========================
     M30
  ========================== */

  const m30 =
    tf.M30 || {};

  let m30Text =
    m30.bias ||
    "WAIT";

  if (
    m30.zone &&
    m30.zone !==
      "EQUILIBRIUM"
  ) {

    m30Text +=
      " / " +
      m30.zone;

  }

  setDirection(
    m30BiasEl,
    m30Text
  );


  /* ==========================
     M15 ICT SETUP
  ========================== */

  const m15 =
    tf.M15 || {};

  let m15Text =
    "WAIT";


  if (
    m15.bullishMSS &&
    m15.bullishFVG
  ) {

    m15Text =
      "BULLISH ICT";

  } else if (
    m15.bearishMSS &&
    m15.bearishFVG
  ) {

    m15Text =
      "BEARISH ICT";

  } else if (
    m15.sellSideSweep
  ) {

    m15Text =
      "SELL-SIDE SWEPT";

  } else if (
    m15.buySideSweep
  ) {

    m15Text =
      "BUY-SIDE SWEPT";

  } else if (
    m15.bullishFVG
  ) {

    m15Text =
      "BULLISH FVG";

  } else if (
    m15.bearishFVG
  ) {

    m15Text =
      "BEARISH FVG";

  }


  setDirection(
    m15SetupEl,
    m15Text
  );


  /* ==========================
     M5 ENTRY
  ========================== */

  const m5 =
    tf.M5 || {};

  let m5Text =
    "WAIT";


  if (
    m5.buyConfirmation
  ) {

    m5Text =
      "BUY READY";

  } else if (
    m5.sellConfirmation
  ) {

    m5Text =
      "SELL READY";

  } else if (
    m5.bullishFVG
  ) {

    m5Text =
      "BUY FVG";

  } else if (
    m5.bearishFVG
  ) {

    m5Text =
      "SELL FVG";

  }


  setDirection(
    m5EntryEl,
    m5Text
  );


  /* ==========================
     SERVER STATUS
  ========================== */

  if (statusEl) {

    if (
      data.scanning
    ) {

      statusEl.textContent =
        "Scanning H1 • M30 • M15 • M5...";

    } else if (
      data.lastError
    ) {

      statusEl.textContent =
        data.lastError;

    } else {

      statusEl.textContent =
        "ICT scanner running";

    }

  }


  if (
    lastScanEl
  ) {

    if (
      data.lastScanAt
    ) {

      lastScanEl.textContent =
        new Date(
          data.lastScanAt
        ).toLocaleString();

    } else {

      lastScanEl.textContent =
        "--";

    }

  }


  /* HISTORY */

  showHistory(
    data.history || []
  );

}


/* ==============================
   HISTORY
================================ */

function showHistory(
  history
) {

  if (!historyEl) {
    return;
  }

  historyEl.innerHTML =
    "";

  if (
    !Array.isArray(
      history
    ) ||
    history.length === 0
  ) {

    historyEl.innerHTML =
      `
      <div class="empty">
        No ICT Sharp Entry signals yet
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


      const type =
        item.type ||
        "WAIT";


      card.innerHTML = `

        <div class="history-head">

          <div
            class="history-type ${
              type === "BUY"
                ? "buy"
                : type === "SELL"
                ? "sell"
                : "wait"
            }"
          >
            ${type}
          </div>

          <div
            class="history-confidence"
          >
            ${item.confidence || 0}%
          </div>

        </div>


        <div class="history-levels">

          Entry:
          ${displayPrice(
            item.entry
          )}

          <br>

          SL:
          ${displayPrice(
            item.sl
          )}

          <br>

          TP1:
          ${displayPrice(
            item.tp1
          )}

          &nbsp; • &nbsp;

          TP2:
          ${displayPrice(
            item.tp2
          )}

          &nbsp; • &nbsp;

          TP3:
          ${displayPrice(
            item.tp3
          )}

        </div>


        <div
          class="history-reason"
        >
          ${item.reason || ""}
        </div>


        <div
          class="history-time"
        >
          ${
            item.time
              ? new Date(
                  item.time
                ).toLocaleString()
              : ""
          }
        </div>

      `;


      historyEl.appendChild(
        card
      );

    }
  );

}


/* ==============================
   MANUAL ICT SCAN
================================ */

if (scanButton) {

  scanButton.addEventListener(
    "click",
    async () => {

      scanButton.disabled =
        true;

      scanButton.textContent =
        "Scanning H1 • M30 • M15 • M5...";


      try {

        const response =
          await fetch(
            "/api/scan",
            {
              method:
                "POST"
            }
          );


        if (
          !response.ok
        ) {

          throw new Error(
            "Scan failed"
          );

        }


        const data =
          await response.json();


        updateScreen(
          data
        );


      } catch (error) {

        if (
          statusEl
        ) {

          statusEl.textContent =
            "ICT scan failed";

        }

      }


      scanButton.disabled =
        false;

      scanButton.textContent =
        "Scan Gold Now";

    }
  );

}


/* ==============================
   PUSH HELPER
================================ */

function urlBase64ToUint8Array(
  base64String
) {

  const padding =
    "=".repeat(
      (
        4 -
        base64String.length %
          4
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


/* ==============================
   ENABLE NOTIFICATIONS
================================ */

async function enableNotifications() {

  try {

    if (
      !(
        "serviceWorker"
        in navigator
      )
    ) {

      alert(
        "This browser does not support push notifications."
      );

      return;

    }


    if (
      !(
        "Notification"
        in window
      )
    ) {

      alert(
        "Open Sharp Entry from your iPhone Home Screen to enable notifications."
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
        "Notifications were not allowed."
      );

      return;

    }


    const registration =
      await navigator
        .serviceWorker
        .register(
          "/sw.js"
        );


    await navigator
      .serviceWorker
      .ready;


    const keyResponse =
      await fetch(
        "/api/vapid-public-key",
        {
          cache:
            "no-store"
        }
      );


    const keyData =
      await keyResponse
        .json();


    if (
      !keyData.publicKey
    ) {

      alert(
        "VAPID notification keys are missing on Railway."
      );

      return;

    }


    let subscription =
      await registration
        .pushManager
        .getSubscription();


    if (
      !subscription
    ) {

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


    const saveResponse =
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


    if (
      !saveResponse.ok
    ) {

      throw new Error(
        "Could not save notification subscription"
      );

    }


    alert(
      "🔥 ICT Sharp Entry notifications enabled."
    );


  } catch (error) {

    console.log(
      "Notification error:",
      error
    );

    alert(
      "Notification error: " +
      error.message
    );

  }

}


if (
  notificationButton
) {

  notificationButton
    .addEventListener(
      "click",
      enableNotifications
    );

}


/* ==============================
   TEST NOTIFICATION
================================ */

if (
  testNotificationButton
) {

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
            await response
              .json();


          if (
            !response.ok
          ) {

            throw new Error(
              data.error ||
              "Test failed"
            );

          }


          alert(
            "Test notification sent."
          );


        } catch (error) {

          alert(
            "Test notification failed: " +
            error.message
          );

        }

      }
    );

}


/* ==============================
   START
================================ */

loadStatus();


setInterval(
  loadStatus,
  15000
);
