const express = require("express");
const path = require("path");
const webpush = require("web-push");

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:admin@example.com";

app.use(express.json());
app.use(express.static(__dirname));

let subscriptions = [];
let lastSignal = {
  signal: "WAIT",
  message: "Waiting for market analysis",
  entry: null,
  sl: null,
  tp1: null,
  tp2: null,
  tp3: null,
  confidence: 0,
  h1: "—",
  m15: "—",
  updatedAt: null
};

let lastNotificationKey = "";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_EMAIL,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

function ema(values, period) {
  if (!values.length) return 0;

  const multiplier = 2 / (period + 1);
  let value = values[0];

  for (let i = 1; i < values.length; i++) {
    value =
      values[i] * multiplier +
      value * (1 - multiplier);
  }

  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  if (losses === 0) return 100;

  const rs = gains / losses;

  return 100 - 100 / (1 + rs);
}

async function getTimeSeries(interval, outputsize = 100) {
  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=XAU/USD` +
    `&interval=${interval}` +
    `&outputsize=${outputsize}` +
    `&apikey=${API_KEY}`;

  const response = await fetch(url);
  const data = await response.json();

  if (!data.values) {
    throw new Error(
      data.message || "No XAU/USD market data received"
    );
  }

  return data.values.reverse();
}

async function analyzeGold() {
  const [m5, m15, h1] = await Promise.all([
    getTimeSeries("5min", 100),
    getTimeSeries("15min", 100),
    getTimeSeries("1h", 100)
  ]);

  const m5Close = m5.map(c => Number(c.close));
  const m5High = m5.map(c => Number(c.high));
  const m5Low = m5.map(c => Number(c.low));

  const m15Close = m15.map(c => Number(c.close));
  const h1Close = h1.map(c => Number(c.close));

  const latest = m5[m5.length - 1];
  const price = Number(latest.close);

  const h1Ema20 = ema(h1Close.slice(-40), 20);
  const h1Ema50 = ema(h1Close.slice(-70), 50);

  const m15Ema20 = ema(m15Close.slice(-40), 20);
  const m15Ema50 = ema(m15Close.slice(-70), 50);

  const m5Ema20 = ema(m5Close.slice(-40), 20);
  const currentRSI = rsi(m5Close, 14);

  const recentHigh = Math.max(
    ...m5High.slice(-10, -1)
  );

  const recentLow = Math.min(
    ...m5Low.slice(-10, -1)
  );

  const h1Trend =
    h1Ema20 > h1Ema50
      ? "BULLISH"
      : h1Ema20 < h1Ema50
      ? "BEARISH"
      : "NEUTRAL";

  const m15Structure =
    m15Ema20 > m15Ema50
      ? "BULLISH"
      : m15Ema20 < m15Ema50
      ? "BEARISH"
      : "NEUTRAL";

  let signal = "WAIT";
  let confidence = 0;

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
  }

  let sl = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  if (signal === "BUY") {
    sl = recentLow;

    const risk = price - sl;

    tp1 = price + risk;
    tp2 = price + risk * 2;
    tp3 = price + risk * 3;
  }

  if (signal === "SELL") {
    sl = recentHigh;

    const risk = sl - price;

    tp1 = price - risk;
    tp2 = price - risk * 2;
    tp3 = price - risk * 3;
  }

  lastSignal = {
    signal,
    message:
      signal === "WAIT"
        ? "No qualified sharp entry yet"
        : `${signal} setup detected on XAU/USD`,
    entry:
      signal === "WAIT"
        ? null
        : Number(price.toFixed(2)),
    sl:
      sl === null
        ? null
        : Number(sl.toFixed(2)),
    tp1:
      tp1 === null
        ? null
        : Number(tp1.toFixed(2)),
    tp2:
      tp2 === null
        ? null
        : Number(tp2.toFixed(2)),
    tp3:
      tp3 === null
        ? null
        : Number(tp3.toFixed(2)),
    confidence,
    h1: h1Trend,
    m15: m15Structure,
    updatedAt: new Date().toISOString()
  };

  return {
    ...lastSignal,
    candleTime: latest.datetime
  };
}

async function sendPushToAll(data) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    console.log("VAPID keys are missing");
    return;
  }

  const payload = JSON.stringify({
    title: data.title,
    body: data.body,
    url: "/"
  });

  const surviving = [];

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        subscription,
        payload
      );

      surviving.push(subscription);
    } catch (error) {
      if (
        error.statusCode !== 404 &&
        error.statusCode !== 410
      ) {
        surviving.push(subscription);
      }

      console.log(
        "Push error:",
        error.statusCode || error.message
      );
    }
  }

  subscriptions = surviving;
}

async function backgroundScan() {
  try {
    const result = await analyzeGold();

    console.log(
      new Date().toISOString(),
      result.signal,
      result.entry || ""
    );

    if (result.signal === "WAIT") return;

    const key =
      result.signal + "-" + result.candleTime;

    if (key === lastNotificationKey) return;

    lastNotificationKey = key;

    await sendPushToAll({
      title: `🔥 Sharp Entry V3 — ${result.signal}`,
      body:
        `XAU/USD\n` +
        `Entry: ${result.entry}\n` +
        `SL: ${result.sl}\n` +
        `TP1: ${result.tp1}\n` +
        `TP2: ${result.tp2}\n` +
        `TP3: ${result.tp3}`
    });
  } catch (error) {
    console.log(
      "Background scan error:",
      error.message
    );
  }
}

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "Index.html")
  );
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "Sharp Entry V3",
    symbol: "XAU/USD",
    lastSignal
  });
});

app.get("/api/scan", async (req, res) => {
  try {
    const result = await analyzeGold();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get(
  "/api/vapid-public-key",
  (req, res) => {
    if (!VAPID_PUBLIC_KEY) {
      return res.status(500).json({
        error: "VAPID public key missing"
      });
    }

    res.json({
      publicKey: VAPID_PUBLIC_KEY
    });
  }
);

app.post("/api/subscribe", (req, res) => {
  const subscription = req.body;

  if (
    !subscription ||
    !subscription.endpoint
  ) {
    return res.status(400).json({
      error: "Invalid subscription"
    });
  }

  const exists = subscriptions.some(
    item =>
      item.endpoint ===
      subscription.endpoint
  );

  if (!exists) {
    subscriptions.push(subscription);
  }

  res.status(201).json({
    success: true
  });
});

app.post(
  "/api/test-notification",
  async (req, res) => {
    try {
      await sendPushToAll({
        title: "🔥 Sharp Entry V3",
        body:
          "Test successful. iPhone signal notifications are working."
      });

      res.json({
        success: true
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }
);

setInterval(
  backgroundScan,
  60 * 1000
);

backgroundScan();

app.listen(PORT, () => {
  console.log(
    `Sharp Entry V3 running on port ${PORT}`
  );
});
