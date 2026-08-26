const express = require("express");
const path = require("path");
const fs = require("fs");
const webpush = require("web-push");

const app = express();
const PORT = process.env.PORT || 3000;

/* ==============================
   CONFIGURATION
================================ */

const API_KEY = process.env.TWELVE_DATA_API_KEY || "";

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || "";

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "";

const VAPID_EMAIL =
  process.env.VAPID_EMAIL ||
  "mailto:admin@example.com";

/*
  Original Sharp Entry style:
  H1 = main trend
  M15 = confirmation
  M5 = sharp entry

  No ICT
  No FVG
  No BOS
  No Order Blocks
  No AI
*/

const SYMBOL = "XAU/USD";

const SCAN_INTERVAL_MINUTES = 5;

const MIN_SIGNAL_CONFIDENCE = 85;

const HISTORY_FILE = path.join(
  __dirname,
  "signal-history.json"
);

const SUBSCRIPTIONS_FILE = path.join(
  __dirname,
  "subscriptions.json"
);

/* ==============================
   EXPRESS
================================ */

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* ==============================
   PUSH NOTIFICATIONS
================================ */

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

/* ==============================
   FILE HELPERS
================================ */

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch (error) {
    console.error(
      "File load error:",
      error.message
    );

    return fallback;
  }
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    console.error(
      "File save error:",
      error.message
    );
  }
}

/* ==============================
   HISTORY + SUBSCRIPTIONS
================================ */

let history = loadJSON(
  HISTORY_FILE,
  []
);

let subscriptions = loadJSON(
  SUBSCRIPTIONS_FILE,
  []
);

/* ==============================
   SERVER STATE
================================ */

let state = {
  scanning: false,

  lastScanAt: null,

  nextScanAt: null,

  lastError: null,

  market: {
    symbol: SYMBOL,
    price: null,
    updatedAt: null
  },

  signal: {
    type: "WAIT",
    confidence: 0,

    buyScore: 0,
    sellScore: 0,

    entry: null,

    stopLoss: null,

    tp1: null,
    tp2: null,
    tp3: null,

    h1Trend: "WAIT",
    m15Trend: "WAIT",
    m5Trigger: "WAIT",

    rsi: null,

    reason:
      "Waiting for market data"
  }
};

/* ==============================
   TECHNICAL FUNCTIONS
================================ */

function average(values) {
  if (!values.length) return 0;

  return (
    values.reduce(
      (a, b) => a + b,
      0
    ) / values.length
  );
}

function ema(values, period) {
  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let result = average(
    values.slice(0, period)
  );

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function calculateRSI(
  values,
  period = 14
) {
  if (
    !values ||
    values.length <= period
  ) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  const start =
    values.length - period;

  for (
    let i = start;
    i < values.length;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses +=
        Math.abs(change);
    }
  }

  const avgGain =
    gains / period;

  const avgLoss =
    losses / period;

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

/* ==============================
   CANDLE AGGREGATION
================================ */

/*
  We download M5 candles once.

  Then create M15 and H1 candles
  locally.

  This reduces unnecessary API calls.
*/

function aggregateCandles(
  candles,
  groupSize
) {
  const result = [];

  for (
    let i = 0;
    i + groupSize <= candles.length;
    i += groupSize
  ) {
    const group =
      candles.slice(
        i,
        i + groupSize
      );

    result.push({
      open: group[0].open,

      high: Math.max(
        ...group.map(
          c => c.high
        )
      ),

      low: Math.min(
        ...group.map(
          c => c.low
        )
      ),

      close:
        group[
          group.length - 1
        ].close
    });
  }

  return result;
}

/* ==============================
   GET MARKET DATA
================================ */

async function getMarketData() {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(SYMBOL) +
    "&interval=5min" +
    "&outputsize=600" +
    "&apikey=" +
    encodeURIComponent(API_KEY);

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      "Market API connection failed"
    );
  }

  const data =
    await response.json();

  if (
    data.status === "error"
  ) {
    throw new Error(
      data.message ||
      "Twelve Data error"
    );
  }

  if (
    !Array.isArray(data.values)
  ) {
    throw new Error(
      "No market candles received"
    );
  }

  /*
    Twelve Data normally returns
    newest candle first.

    Reverse so calculations run
    oldest -> newest.
  */

  const candles =
    data.values
      .map(c => ({
        open:
          Number(c.open),

        high:
          Number(c.high),

        low:
          Number(c.low),

        close:
          Number(c.close)
      }))
      .reverse();

  return candles;
}

/* ==============================
   SHARP ENTRY ENGINE
================================ */

function analyzeMarket(
  m5Candles
) {
  const m15Candles =
    aggregateCandles(
      m5Candles,
      3
    );

  const h1Candles =
    aggregateCandles(
      m5Candles,
      12
    );

  if (
    m5Candles.length < 100 ||
    m15Candles.length < 50 ||
    h1Candles.length < 30
  ) {
    throw new Error(
      "Not enough candle data"
    );
  }

  const m5Close =
    m5Candles.map(
      c => c.close
    );

  const m15Close =
    m15Candles.map(
      c => c.close
    );

  const h1Close =
    h1Candles.map(
      c => c.close
    );

  const current =
    m5Candles[
      m5Candles.length - 1
    ];

  const previous =
    m5Candles[
      m5Candles.length - 2
    ];

  const price =
    current.close;

  /* ==========================
     H1 TREND
  ========================== */

  const h1Fast =
    ema(h1Close, 10);

  const h1Slow =
    ema(h1Close, 20);

  let h1Trend = "SIDEWAYS";

  if (
    h1Fast > h1Slow &&
    price > h1Fast
  ) {
    h1Trend = "BULLISH";
  }

  if (
    h1Fast < h1Slow &&
    price < h1Fast
  ) {
    h1Trend = "BEARISH";
  }

  /* ==========================
     M15 CONFIRMATION
  ========================== */

  const m15Fast =
    ema(m15Close, 9);

  const m15Slow =
    ema(m15Close, 21);

  let m15Trend = "SIDEWAYS";

  if (
    m15Fast > m15Slow
  ) {
    m15Trend = "BULLISH";
  }

  if (
    m15Fast < m15Slow
  ) {
    m15Trend = "BEARISH";
  }

  /* ==========================
     M5 ENTRY
  ========================== */

  const m5Fast =
    ema(m5Close, 9);

  const m5Slow =
    ema(m5Close, 21);

  const rsi =
    calculateRSI(
      m5Close,
      14
    );

  let m5Trigger = "WAIT";

  if (
    m5Fast > m5Slow &&
    current.close >
      current.open &&
    current.close >
      previous.close
  ) {
    m5Trigger = "BUY";
  }

  if (
    m5Fast < m5Slow &&
    current.close <
      current.open &&
    current.close <
      previous.close
  ) {
    m5Trigger = "SELL";
  }

  /* ==========================
     SCORING
  ========================== */

  let buyScore = 0;
  let sellScore = 0;

  /*
    H1 trend = 35 points
  */

  if (
    h1Trend === "BULLISH"
  ) {
    buyScore += 35;
  }

  if (
    h1Trend === "BEARISH"
  ) {
    sellScore += 35;
  }

  /*
    M15 confirmation = 30
  */

  if (
    m15Trend === "BULLISH"
  ) {
    buyScore += 30;
  }

  if (
    m15Trend === "BEARISH"
  ) {
    sellScore += 30;
  }

  /*
    M5 trigger = 25
  */

  if (
    m5Trigger === "BUY"
  ) {
    buyScore += 25;
  }

  if (
    m5Trigger === "SELL"
  ) {
    sellScore += 25;
  }

  /*
    RSI momentum = 10
  */

  if (
    rsi >= 52 &&
    rsi <= 72
  ) {
    buyScore += 10;
  }

  if (
    rsi <= 48 &&
    rsi >= 28
  ) {
    sellScore += 10;
  }

  buyScore =
    Math.min(
      100,
      buyScore
    );

  sellScore =
    Math.min(
      100,
      sellScore
    );

  /* ==========================
     FINAL SIGNAL
  ========================== */

  let type = "WAIT";
  let confidence =
    Math.max(
      buyScore,
      sellScore
    );

  if (
    buyScore >=
      MIN_SIGNAL_CONFIDENCE &&
    buyScore > sellScore
  ) {
    type = "BUY";
    confidence = buyScore;
  }

  if (
    sellScore >=
      MIN_SIGNAL_CONFIDENCE &&
    sellScore > buyScore
  ) {
    type = "SELL";
    confidence = sellScore;
  }

  /* ==========================
     SL + TP CALCULATION
  ========================== */

  let stopLoss = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  const recent =
    m5Candles.slice(-12);

  const recentHigh =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );

  const recentLow =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );

  if (type === "BUY") {
    stopLoss = recentLow;

    const risk =
      price - stopLoss;

    if (risk > 0) {
      tp1 =
        price + risk;

      tp2 =
        price +
        risk * 2;

      tp3 =
        price +
        risk * 3;
    }
  }

  if (type === "SELL") {
    stopLoss = recentHigh;

    const risk =
      stopLoss - price;

    if (risk > 0) {
      tp1 =
        price - risk;

      tp2 =
        price -
        risk * 2;

      tp3 =
        price -
        risk * 3;
    }
  }

  function clean(number) {
    if (
      number === null ||
      !Number.isFinite(number)
    ) {
      return null;
    }

    return Number(
      number.toFixed(2)
    );
  }

  let reason =
    "No strong setup yet";

  if (type === "BUY") {
    reason =
      "Bullish trend and entry confirmation aligned";
  }

  if (type === "SELL") {
    reason =
      "Bearish trend and entry confirmation aligned";
  }

  return {
    symbol: SYMBOL,

    type,

    confidence,

    buyScore,

    sellScore,

    entry: clean(price),

    stopLoss:
      clean(stopLoss),

    tp1: clean(tp1),

    tp2: clean(tp2),

    tp3: clean(tp3),

    h1Trend,

    m15Trend,

    m5Trigger,

    rsi:
      Number(
        rsi.toFixed(1)
      ),

    reason,

    createdAt:
      new Date()
        .toISOString()
  };
}

/* ==============================
   PUSH SIGNAL
================================ */

async function sendPushToAll(
  title,
  body
) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    console.log(
      "Push notifications not configured"
    );

    return;
  }

  const payload =
    JSON.stringify({
      title,
      body,
      url: "/"
    });

  const valid = [];

  for (
    const subscription
    of subscriptions
  ) {
    try {
      await webpush.sendNotification(
        subscription,
        payload
      );

      valid.push(
        subscription
      );
    } catch (error) {
      /*
        404/410 usually means
        subscription expired.
      */

      if (
        error.statusCode !== 404 &&
        error.statusCode !== 410
      ) {
        valid.push(
          subscription
        );
      }

      console.error(
        "Push error:",
        error.message
      );
    }
  }

  subscriptions = valid;

  saveJSON(
    SUBSCRIPTIONS_FILE,
    subscriptions
  );
}

/* ==============================
   SAVE SIGNAL HISTORY
================================ */

function saveSignal(signal) {
  history.unshift(signal);

  /*
    Keep latest 100 signals.
  */

  history =
    history.slice(0, 100);

  saveJSON(
    HISTORY_FILE,
    history
  );
}

/* ==============================
   BACKGROUND SCANNER
================================ */

async function backgroundScan() {
  if (state.scanning) {
    return;
  }

  state.scanning = true;
  state.lastError = null;

  try {
    console.log(
      "Scanning XAU/USD..."
    );

    const candles =
      await getMarketData();

    const result =
      analyzeMarket(candles);

    state.market.price =
      result.entry;

    state.market.updatedAt =
      new Date()
        .toISOString();

    const previousType =
      state.signal.type;

    state.signal = result;

    state.lastScanAt =
      new Date()
        .toISOString();

    /*
      Save and notify only
      qualified BUY/SELL signals.
    */

    if (
      result.type === "BUY" ||
      result.type === "SELL"
    ) {
      const lastSignal =
        history[0];

      const duplicate =
        lastSignal &&
        lastSignal.type ===
          result.type &&
        Math.abs(
          new Date(
            result.createdAt
          ).getTime() -
          new Date(
            lastSignal.createdAt
          ).getTime()
        ) <
          15 * 60 * 1000;

      if (!duplicate) {
        saveSignal(result);

        await sendPushToAll(
          `🔥 Sharp Entry ${result.type}`,
          `${SYMBOL}
Entry: ${result.entry}
SL: ${result.stopLoss}
TP1: ${result.tp1}
TP2: ${result.tp2}
TP3: ${result.tp3}
Confidence: ${result.confidence}%`
        );
      }
    }

    console.log(
      "Scan complete:",
      result.type,
      result.confidence + "%"
    );
  } catch (error) {
    state.lastError =
      error.message;

    console.error(
      "Scanner error:",
      error.message
    );
  } finally {
    state.scanning = false;

    state.nextScanAt =
      new Date(
        Date.now() +
        SCAN_INTERVAL_MINUTES *
          60 *
          1000
      ).toISOString();
  }
}

/* ==============================
   API ROUTES
================================ */

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      ...state,

      historyCount:
        history.length,

      notificationsConfigured:
        Boolean(
          VAPID_PUBLIC_KEY &&
          VAPID_PRIVATE_KEY
        )
    });
  }
);

app.get(
  "/api/history",
  (req, res) => {
    res.json(history);
  }
);

app.post(
  "/api/scan",
  async (req, res) => {
    await backgroundScan();

    res.json(state);
  }
);

/* ==============================
   PUSH PUBLIC KEY
================================ */

app.get(
  "/api/vapid-public-key",
  (req, res) => {
    res.json({
      publicKey:
        VAPID_PUBLIC_KEY
    });
  }
);

/* ==============================
   SAVE PHONE SUBSCRIPTION
================================ */

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
        s =>
          s.endpoint ===
          subscription.endpoint
      );

    if (!exists) {
      subscriptions.push(
        subscription
      );

      saveJSON(
        SUBSCRIPTIONS_FILE,
        subscriptions
      );
    }

    res.json({
      success: true
    });
  }
);

/* ==============================
   TEST NOTIFICATION
================================ */

app.post(
  "/api/test-notification",
  async (req, res) => {
    try {
      await sendPushToAll(
        "🔥 Sharp Entry V3",
        "Test successful. Signal notifications are working."
      );

      res.json({
        success: true
      });
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

/* ==============================
   START BACKGROUND SCANNER
================================ */

setInterval(
  backgroundScan,
  SCAN_INTERVAL_MINUTES *
    60 *
    1000
);

/*
  Run once when Railway
  starts/restarts the server.
*/

backgroundScan();

/* ==============================
   START SERVER
================================ */

app.listen(
  PORT,
  () => {
    console.log(
      `Sharp Entry V3 running on port ${PORT}`
    );

    console.log(
      `Automatic scan every ${SCAN_INTERVAL_MINUTES} minutes`
    );

    console.log(
      `Minimum confidence ${MIN_SIGNAL_CONFIDENCE}%`
    );
  }
);
