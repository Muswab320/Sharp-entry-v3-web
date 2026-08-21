const $ = id => document.getElementById(id);

let latestChart = [];
let swRegistration = null;

const fmt = n =>
  Number.isFinite(Number(n))
    ? Number(n).toFixed(2)
    : "—";

function toast(msg, error = false) {
  const t = $("toast");

  t.textContent = msg;
  t.className =
    "toast show" +
    (error ? " error" : "");

  clearTimeout(window.__toast);

  window.__toast =
    setTimeout(() => {
      t.className = "toast";
    }, 3000);
}

function setSignalClass(el, signal) {
  el.className =
    "signal-badge " +
    String(signal || "WAIT")
      .toLowerCase();
}

function drawChart(points) {
  const canvas = $("chart");
  if (!canvas) return;

  const rect =
    canvas.getBoundingClientRect();

  const dpr =
    window.devicePixelRatio || 1;

  canvas.width =
    Math.max(1, rect.width * dpr);

  canvas.height =
    Math.max(1, 120 * dpr);

  const ctx =
    canvas.getContext("2d");

  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = 120;

  ctx.clearRect(0, 0, w, h);

  if (
    !points ||
    points.length < 2
  ) {
    return;
  }

  const vals =
    points.map(p =>
      Number(p.close)
    );

  const min =
    Math.min(...vals);

  const max =
    Math.max(...vals);

  const range =
    max - min || 1;

  ctx.beginPath();

  vals.forEach((v, i) => {
    const x =
      (i /
        (vals.length - 1)) *
      w;

    const y =
      h -
      10 -
      ((v - min) / range) *
        (h - 20);

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  const grad =
    ctx.createLinearGradient(
      0,
      0,
      w,
      0
    );

  grad.addColorStop(
    0,
    "#44e3a1"
  );

  grad.addColorStop(
    1,
    "#6cd8e8"
  );

  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function renderSignal(s) {
  if (!s) return;

  $("signalBadge").textContent =
    s.signal || "WAIT";

  setSignalClass(
    $("signalBadge"),
    s.signal
  );

  $("action").textContent =
    s.action ||
    "WAIT FOR CONFIRMATION";

  $("price").textContent =
    fmt(s.entry);

  $("marketTime").textContent =
    "Last candle: " +
    (s.candleTime || "—");

  $("aiConfidence").textContent =
    (s.confidence ?? 0) + "%";

  $("setupQuality").textContent =
    s.setupQuality || "WAIT";

  $("lotSuggestion").textContent =
    s.lotSuggestion ||
    "NO TRADE";

  $("tradeStatus").textContent =
    s.tradeStatus ||
    "WAITING";

  $("trend").textContent =
    s.trend ||
    s.h1 ||
    "—";

  $("structure").textContent =
    s.structure ||
    s.m15 ||
    "—";

  $("bos").textContent =
    s.bos ||
    "WAITING";

  $("bosLevel").textContent =
    fmt(s.bosLevel);

  $("retest").textContent =
    s.retest ||
    "WAITING";

  $("m5Confirmation").textContent =
    s.m5Confirmation ||
    "WAITING";

  $("entry").textContent =
    fmt(s.entry);

  $("sl").textContent =
    fmt(s.sl);

  $("tp1").textContent =
    fmt(s.tp1);

  $("tp2").textContent =
    fmt(s.tp2);

  $("tp3").textContent =
    fmt(s.tp3);

  $("rsi").textContent =
    fmt(s.rsi);

  const reasons =
    $("reasons");

  reasons.innerHTML = "";

  (s.reasons || []).forEach(r => {
    const d =
      document.createElement(
        "div"
      );

    d.className = "reason";
    d.textContent = r;

    reasons.appendChild(d);
  });

  if (
    !(s.reasons || []).length
  ) {
    reasons.innerHTML =
      '<div class="empty">No strong confirmation yet.</div>';
  }

  latestChart =
    s.chart || [];

  drawChart(latestChart);
}

async function refreshStatus() {
  try {
    const r =
      await fetch(
        "/api/status",
        {
          cache: "no-store"
        }
      );

    if (!r.ok) {
      throw new Error();
    }

    const d =
      await r.json();

    const pill =
      $("serverPill");

    pill.className =
      "status-pill good";

    pill.querySelector(
      "span"
    ).textContent =
      d.scanning
        ? "Scanning"
        : "AI Scanner Online";

    $("scanStatus").textContent =
      d.scanning
        ? "Scanning now…"
        : `Every ${d.config.intervalMinutes} min`;

    $("intervalText").textContent =
      `Every ${d.config.intervalMinutes} minutes`;

    $("apiStatus").textContent =
      d.config.marketApiConfigured
        ? "Connected"
        : "Needs key";

    $("apiStatus").className =
      "mini-pill " +
      (
        d.config.marketApiConfigured
          ? "good"
          : "bad"
      );

    if (d.signal) {
      renderSignal(d.signal);
    }

    if (d.lastError) {
      pill.className =
        "status-pill bad";

      pill.querySelector(
        "span"
      ).textContent =
        "Needs attention";
    }
  } catch (e) {
    const pill =
      $("serverPill");

    pill.className =
      "status-pill bad";

    pill.querySelector(
      "span"
    ).textContent =
      "Offline";
  }
}

async function loadHistory() {
  try {
    const r =
      await fetch(
        "/api/history",
        {
          cache: "no-store"
        }
      );

    const d =
      await r.json();

    const list =
      $("historyList");

    list.innerHTML = "";

    const history =
      d.history || [];

    $("historyCount").textContent =
      `${history.length} saved`;

    if (!history.length) {
      list.innerHTML =
        '<div class="empty">No BUY, SELL or EXIT signals recorded yet.</div>';

      return;
    }

    history.forEach(s => {
      const el =
        document.createElement(
          "div"
        );

      el.className =
        "history-item";

      el.innerHTML =
        `
        <div class="history-top">
          <span class="history-signal ${String(
            s.signal
          ).toLowerCase()}">
            ${s.signal} · ${s.confidence ?? 0}%
          </span>

          <strong>
            ${fmt(s.entry)}
          </strong>
        </div>

        <div class="history-meta">
          ${s.candleTime || "—"}
          <br>
          Setup: ${s.setupQuality || "—"}
          · Lot: ${s.lotSuggestion || "—"}
          <br>
          BOS: ${s.bos || "—"}
          · Retest: ${s.retest || "—"}
          · M5: ${s.m5Confirmation || "—"}
          <br>
          SL ${fmt(s.sl)}
          · TP1 ${fmt(s.tp1)}
          · TP2 ${fmt(s.tp2)}
          · TP3 ${fmt(s.tp3)}
        </div>
        `;

      list.appendChild(el);
    });
  } catch (e) {
    toast(
      "Could not load history",
      true
    );
  }
}

async function registerServiceWorker() {
  if (
    !(
      "serviceWorker"
      in navigator
    )
  ) {
    return null;
  }

  try {
    swRegistration =
      await navigator
        .serviceWorker
        .register("/sw.js");

    await navigator
      .serviceWorker
      .ready;

    return swRegistration;
  } catch (error) {
    console.log(
      "Service worker error:",
      error
    );

    return null;
  }
}

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
      .replace(/-/g, "+")
      .replace(/_/g, "/");

  const rawData =
    window.atob(base64);

  return Uint8Array.from(
    [...rawData].map(
      char =>
        char.charCodeAt(0)
    )
  );
}

async function enableNotifications() {
  try {
    if (
      !(
        "Notification"
        in window
      )
    ) {
      throw new Error(
        "Notifications are not supported here."
      );
    }

    const permission =
      await Notification
        .requestPermission();

    if (
      permission !==
      "granted"
    ) {
      throw new Error(
        "Notification permission was not granted."
      );
    }

    if (!swRegistration) {
      await registerServiceWorker();
    }

    const readyRegistration =
      await navigator
        .serviceWorker
        .ready;

    const keyResponse =
      await fetch(
        "/api/vapid-public-key",
        {
          cache: "no-store"
        }
      );

    if (!keyResponse.ok) {
      throw new Error(
        "Could not get notification key."
      );
    }

    const keyData =
      await keyResponse.json();

    let subscription =
      await readyRegistration
        .pushManager
        .getSubscription();

    if (!subscription) {
      subscription =
        await readyRegistration
          .pushManager
          .subscribe({
            userVisibleOnly: true,
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

    if (!saveResponse.ok) {
      throw new Error(
        "Could not save notification subscription."
      );
    }

    toast(
      "iPhone notifications enabled ✅"
    );
  } catch (error) {
    toast(
      error.message ||
      "Could not enable notifications",
      true
    );
  }
}

async function testNotification() {
  try {
    if (
      Notification.permission !==
      "granted"
    ) {
      throw new Error(
        "Enable notifications first."
      );
    }

    const r =
      await fetch(
        "/api/test-notification",
        {
          method: "POST"
        }
      );

    const d =
      await r.json()
        .catch(() => ({}));

    if (!r.ok) {
      throw new Error(
        d.error ||
        "Test notification failed."
      );
    }

    toast(
      "Test notification sent ✅"
    );
  } catch (error) {
    toast(
      error.message,
      true
    );
  }
}

$("scanBtn")
  .addEventListener(
    "click",
    async () => {
      const b =
        $("scanBtn");

      b.disabled = true;

      b.textContent =
        "Analyzing BOS · Retest · M5…";

      try {
        const r =
          await fetch(
            "/api/scan",
            {
              method: "POST"
            }
          );

        const d =
          await r.json();

        if (!r.ok) {
          throw new Error(
            d.error ||
            "Scan failed"
          );
        }

        renderSignal(
          d.result
        );

        toast(
          `${d.result.signal} · ${d.result.confidence}%`
        );

        loadHistory();
      } catch (e) {
        toast(
          e.message,
          true
        );
      } finally {
        b.disabled = false;

        b.textContent =
          "Scan Gold Now";

        refreshStatus();
      }
    }
  );

$("notifyBtn")
  .addEventListener(
    "click",
    enableNotifications
  );

$("testNotifyBtn")
  .addEventListener(
    "click",
    testNotification
  );

document
  .querySelectorAll(".tab")
  .forEach(btn =>
    btn.addEventListener(
      "click",
      () => {
        document
          .querySelectorAll(
            ".tab"
          )
          .forEach(x =>
            x.classList.remove(
              "active"
            )
          );

        document
          .querySelectorAll(
            ".page"
          )
          .forEach(x =>
            x.classList.remove(
              "active"
            )
          );

        btn.classList.add(
          "active"
        );

        $(
          btn.dataset.page
        ).classList.add(
          "active"
        );

        if (
          btn.dataset.page ===
          "history"
        ) {
          loadHistory();
        }
      }
    )
  );

window.addEventListener(
  "resize",
  () =>
    drawChart(
      latestChart
    )
);

registerServiceWorker();
refreshStatus();
loadHistory();

setInterval(
  refreshStatus,
  15000
);
