const express = require("express");
const path = require("path");
const fs = require("fs");
const webpush = require("web-push");

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY || "";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL =
  process.env.VAPID_EMAIL || "mailto:admin@example.com";

const SCAN_INTERVAL_MINUTES = 5;

const HISTORY_FILE = path.join(
  __dirname,
  "signal-history.json"
);

app.use(express.json());
app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

let subscriptions = [];

let state = {
  scanning: false,
  lastScanAt: null,
  lastError: null,
  market: {
    symbol: "XAU/USD",
    price: null,
    updatedAt: null
  },
  signal: null,
  history: loadHistory()
};

let lastNotificationKey = "";

if (
  VAPID_PUBLIC_KEY &&
  VAPID_PRIVATE_KEY
) {
  webpush.setVapidDetails(
    VAPID_EMAIL,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }

    const raw = fs.readFileSync(
      HISTORY_FILE,
      "utf8"
    );

    const parsed = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(
        state.history,
        null,
        2
      )
    );
  } catch (error) {
    console.log(
      "History save error:",
      error.message
    );
  }
}

function ema(values, period) {
  if (!values.length) return 0;

  const k = 2 / (period + 1);
  let result = values[0];

  for (
    let i = 1;
    i < values.length;
    i++
  ) {
    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  if (losses === 0) {
    return 100;
  }

  const rs = gains / losses;

  return 100 - 100 / (1 + rs);
}

async function getTimeSeries(
  interval,
  outputsize = 100
) {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=XAU/USD" +
    `&interval=${interval}` +
    `&outputsize=${outputsize}` +
    `&apikey=${API_KEY}`;

  const response = await fetch(url);

  const data =
    await response.json();

  if (!data.values) {
    throw new Error(
      data.message ||
      "No XAU/USD market data received"
    );
  }

  return data.values.reverse();
}

function getTrendLabel(
  fast,
  slow
) {
  if (fast > slow) {
    return "BULLISH";
  }

  if (fast < slow) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

async function analyzeGold() {
  state.scanning = true;
  state.lastError = null;

  try {
    const [m5, m15, h1] =
      await Promise.all([
        getTimeSeries("5min", 100),
        getTimeSeries("15min", 100),
        getTimeSeries("1h", 100)
      ]);

    const m5Close =
      m5.map(c =>
        Number(c.close)
      );

    const m5High =
      m5.map(c =>
        Number(c.high)
      );

    const m5Low =
      m5.map(c =>
        Number(c.low)
      );

    const m15Close =
      m15.map(c =>
        Number(c.close)
      );

    const h1Close =
      h1.map(c =>
        Number(c.close)
      );

    const latest =
      m5[m5.length - 1];

    const price =
      Number(latest.close);

    const h1Ema20 =
      ema(
        h1Close.slice(-40),
        20
      );

    const h1Ema50 =
      ema(
        h1Close.slice(-70),
        50
      );

    const m15Ema20 =
      ema(
        m15Close.slice(-40),
        20
      );

    const m15Ema50 =
      ema(
        m15Close.slice(-70),
        50
      );

    const m5Ema20 =
      ema(
        m5Close.slice(-40),
        20
      );

    const currentRSI =
      rsi(m5Close, 14);

    const recentHigh =
      Math.max(
        ...m5High.slice(-10, -1)
      );

    const recentLow =
      Math.min(
        ...m5Low.slice(-10, -1)
      );

    const h1Trend =
      getTrendLabel(
        h1Ema20,
        h1Ema50
      );

    const m15Structure =
      getTrendLabel(
        m15Ema20,
        m15Ema50
      );

    const reasons = [];

    let signal = "WAIT";
    let confidence = 0;

    if (
      h1Trend === "BULLISH"
    ) {
      reasons.push(
        "H1 trend is bullish"
      );
    }

    if (
      h1Trend === "BEARISH"
    ) {
      reasons.push(
        "H1 trend is bearish"
      );
    }

    if (
      m15Structure === "BULLISH"
    ) {
      reasons.push(
        "M15 structure is bullish"
      );
    }

    if (
      m15Structure === "BEARISH"
    ) {
      reasons.push(
        "M15 structure is bearish"
      );
    }

    if (
      price > m5Ema20
    ) {
      reasons.push(
        "M5 price is above EMA20"
      );
    }

    if (
      price < m5Ema20
    ) {
      reasons.push(
        "M5 price is below EMA20"
      );
    }

    if (
      h1Trend === "BULLISH" &&
      m15Structure === "BULLISH" &&
      price > m5Ema20 &&
      price > recentHigh &&
      currentRSI > 50 &&
      currentRSI < 75
    ) {
      signal = "BUY";
      confidence = 85;

      reasons.push(
        "M5 breakout confirmed"
      );
    }

    if (
      h1Trend === "BEARISH" &&
      m15Structure === "BEARISH" &&
      price < m5Ema20 &&
      price < recentLow &&
      currentRSI < 50 &&
      currentRSI > 25
    ) {
      signal = "SELL";
      confidence = 85;

      reasons.push(
        "M5 breakdown confirmed"
      );
    }

    if (
      signal === "WAIT"
    ) {
      confidence = 45;
    }

    let sl = null;
    let tp1 = null;
    let tp2 = null;
    let tp3 = null;

    if (
      signal === "BUY"
    ) {
      sl = recentLow;

      const risk =
        price - sl;

      tp1 =
        price + risk;

      tp2 =
        price + risk * 2;

      tp3 =
        price + risk * 3;
    }

    if (
      signal === "SELL"
    ) {
      sl = recentHigh;

      const risk =
        sl - price;

      tp1 =
        price - risk;

      tp2 =
        price - risk * 2;

      tp3 =
        price - risk * 3;
    }

    const chart =
      m5.slice(-30).map(c => ({
        time: c.datetime,
        close: Number(c.close)
      }));

    const result = {
      signal,
      confidence,
      entry:
        Number(
          price.toFixed(2)
        ),
      sl:
        sl === null
          ? null
          : Number(
              sl.toFixed(2)
            ),
      tp1:
        tp1 === null
          ? null
          : Number(
              tp1.toFixed(2)
            ),
      tp2:
        tp2 === null
          ? null
          : Number(
              tp2.toFixed(2)
            ),
      tp3:
        tp3 === null
          ? null
          : Number(
              tp3.toFixed(2)
            ),
      trend: h1Trend,
      structure: m15Structure,
      h1: h1Trend,
      m15: m15Structure,
      rsi:
        Number(
          currentRSI.toFixed(2)
        ),
      reasons,
      chart,
      candleTime:
        latest.datetime,
      scannedAt:
        new Date().toISOString()
    };

    state.market = {
      symbol: "XAU/USD",
      price,
      updatedAt:
        new Date().toISOString()
    };

    state.signal = result;
    state.lastScanAt =
      new Date().toISOString();

    if (
      signal === "BUY" ||
      signal === "SELL"
    ) {
      const historyKey =
        `${signal}-${latest.datetime}`;

      const exists =
        state.history.some(
          item =>
            item.key === historyKey
        );

      if (!exists) {
        state.history.unshift({
          key: historyKey,
          ...result
        });

        state.history =
          state.history.slice(0, 20);

        saveHistory();
      }
    }

    return result;
  } catch (error) {
    state.lastError =
      error.message;

    throw error;
  } finally {
    state.scanning = false;
  }
}

async function sendPushToAll(
  title,
  body
) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    throw new Error(
      "VAPID keys are missing"
    );
  }

  const payload =
    JSON.stringify({
      title,
      body,
      url: "/"
    });

  const survivors = [];

  for (
    const subscription
    of subscriptions
  ) {
    try {
      await webpush
        .sendNotification(
          subscription,
          payload
        );

      survivors.push(
        subscription
      );
    } catch (error) {
      if (
        error.statusCode !== 404 &&
        error.statusCode !== 410
      ) {
        survivors.push(
          subscription
        );
      }
    }
  }

  subscriptions = survivors;
}

async function backgroundScan() {
  try {
    const result =
      await analyzeGold();

    if (
      result.signal !== "BUY" &&
      result.signal !== "SELL"
    ) {
      return;
    }

    const notificationKey =
      `${result.signal}-${result.candleTime}`;

    if (
      notificationKey ===
      lastNotificationKey
    ) {
      return;
    }

    lastNotificationKey =
      notificationKey;

    await sendPushToAll(
      `🔥 Sharp Entry V3 — ${result.signal}`,
      `XAU/USD\nEntry: ${result.entry}\nSL: ${result.sl}\nTP1: ${result.tp1}\nTP2: ${result.tp2}\nTP3: ${result.tp3}`
    );
  } catch (error) {
    console.log(
      "Background scan error:",
      error.message
    );
  }
}

/* WEBSITE */
app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

/* BASIC HEALTH */
app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "online",
      scanner:
        "Sharp Entry V3",
      market:
        state.market,
      signal:
        state.signal
    });
  }
);

/* APP STATUS */
app.get(
  "/api/status",
  (req, res) => {
    res.json({
      scanning:
        state.scanning,
      signal:
        state.signal,
      market:
        state.market,
      lastScanAt:
        state.lastScanAt,
      lastError:
        state.lastError,
      config: {
        intervalMinutes:
          SCAN_INTERVAL_MINUTES,
        marketApiConfigured:
          Boolean(API_KEY),
        pushConfigured:
          Boolean(
            VAPID_PUBLIC_KEY &&
            VAPID_PRIVATE_KEY
          )
      }
    });
  }
);

/* MANUAL SCAN */
app.post(
  "/api/scan",
  async (req, res) => {
    try {
      const result =
        await analyzeGold();

      res.json({
        result
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* SUPPORT OLD GET CALL TOO */
app.get(
  "/api/scan",
  async (req, res) => {
    try {
      const result =
        await analyzeGold();

      res.json(result);
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* HISTORY */
app.get(
  "/api/history",
  (req, res) => {
    res.json({
      history:
        state.history
    });
  }
);

/* PUBLIC VAPID KEY */
app.get(
  "/api/vapid-public-key",
  (req, res) => {
    if (!VAPID_PUBLIC_KEY) {
      return res
        .status(500)
        .json({
          error:
            "VAPID public key missing"
        });
    }

    res.json({
      publicKey:
        VAPID_PUBLIC_KEY
    });
  }
);

/* PUSH SUBSCRIBE */
app.post(
  "/api/subscribe",
  (req, res) => {
    const subscription =
      req.body;

    if (
      !subscription ||
      !subscription.endpoint
    ) {
      return res
        .status(400)
        .json({
          error:
            "Invalid subscription"
        });
    }

    const exists =
      subscriptions.some(
        item =>
          item.endpoint ===
          subscription.endpoint
      );

    if (!exists) {
      subscriptions.push(
        subscription
      );
    }

    res.status(201).json({
      success: true
    });
  }
);

/* TEST PUSH */
app.post(
  "/api/test-notification",
  async (req, res) => {
    try {
      await sendPushToAll(
        "🔥 Sharp Entry V3",
        "Test successful. iPhone notifications are working."
      );

      res.json({
        success: true
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* START BACKGROUND SCANNER */
setInterval(
  backgroundScan,
  SCAN_INTERVAL_MINUTES *
    60 *
    1000
);

backgroundScan();

app.listen(
  PORT,
  () => {
    console.log(
      `Sharp Entry V3 running on port ${PORT}`
    );
  }
);
