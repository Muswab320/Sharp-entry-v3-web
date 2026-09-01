const express = require("express");
const path = require("path");
const fs = require("fs");
const webpush = require("web-push");

const app = express();

const PORT = process.env.PORT || 3000;

const API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || "";

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "";

const VAPID_EMAIL =
  process.env.VAPID_EMAIL ||
  "mailto:admin@example.com";

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

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


/* =========================
   JSON FILE FUNCTIONS
========================= */

function loadJSON(file, fallback = []) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        JSON.stringify(fallback, null, 2)
      );

      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch (error) {
    console.log(
      "JSON load error:",
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
    console.log(
      "JSON save error:",
      error.message
    );
  }
}


let history =
  loadJSON(HISTORY_FILE, []);

let subscriptions =
  loadJSON(SUBSCRIPTIONS_FILE, []);


/* =========================
   STATE
========================= */

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
    reason: "Waiting for scan",
    entry: null,
    sl: null,
    tp1: null,
    tp2: null,
    tp3: null
  },

  analysis: {
    h1Trend: "WAIT",
    m15Trend: "WAIT",
    m5Trigger: "WAIT",
    liquiditySweep: "NONE",
    fvg: "NONE",
    rsi: null,
    buyScore: 0,
    sellScore: 0
  }
};


/* =========================
   PUSH NOTIFICATIONS
========================= */

if (
  VAPID_PUBLIC_KEY &&
  VAPID_PRIVATE_KEY
) {
  try {

    webpush.setVapidDetails(
      VAPID_EMAIL,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );

    console.log(
      "Push notifications configured"
    );

  } catch (error) {

    console.log(
      "VAPID configuration error:",
      error.message
    );
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
    return;
  }

  const payload =
    JSON.stringify({
      title,
      body,
      url: "/"
    });

  const activeSubscriptions = [];

  for (const subscription of subscriptions) {

    try {

      await webpush.sendNotification(
        subscription,
        payload
      );

      activeSubscriptions.push(
        subscription
      );

    } catch (error) {

      if (
        error.statusCode !== 404 &&
        error.statusCode !== 410
      ) {

        activeSubscriptions.push(
          subscription
        );
      }
    }
  }

  subscriptions =
    activeSubscriptions;

  saveJSON(
    SUBSCRIPTIONS_FILE,
    subscriptions
  );
}


/* =========================
   EMA
========================= */

function ema(values, period) {

  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    result =
      values[i] *
        multiplier +
      result *
        (1 - multiplier);
  }

  return result;
}


/* =========================
   RSI
========================= */

function calculateRSI(
  closes,
  period = 14
) {

  if (
    !closes ||
    closes.length <
      period + 1
  ) {
    return null;
  }

  let gains = 0;

  let losses = 0;

  for (
    let i =
      closes.length -
      period;
    i < closes.length;
    i++
  ) {

    const change =
      closes[i] -
      closes[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses +=
        Math.abs(change);
    }
  }

  const averageGain =
    gains / period;

  const averageLoss =
    losses / period;

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}


/* =========================
   AGGREGATE M5 CANDLES
========================= */

function aggregateCandles(
  candles,
  size
) {

  const result = [];

  for (
    let i = 0;
    i + size <= candles.length;
    i += size
  ) {

    const group =
      candles.slice(
        i,
        i + size
      );

    const first =
      group[0];

    const last =
      group[group.length - 1];

    result.push({

      datetime:
        first.datetime,

      open:
        first.open,

      high:
        Math.max(
          ...group.map(
            c => c.high
          )
        ),

      low:
        Math.min(
          ...group.map(
            c => c.low
          )
        ),

      close:
        last.close
    });
  }

  return result;
}


/* =========================
   LIQUIDITY SWEEP
========================= */

function detectLiquiditySweep(
  candles
) {

  if (
    !candles ||
    candles.length < 12
  ) {
    return "NONE";
  }

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      candles.length - 11,
      candles.length - 1
    );

  const previousHigh =
    Math.max(
      ...previous.map(
        c => c.high
      )
    );

  const previousLow =
    Math.min(
      ...previous.map(
        c => c.low
      )
    );


  /*
    SELL-SIDE LIQUIDITY SWEEP

    Price moves below old lows
    then closes back above them.

    This can support BUY.
  */

  if (
    current.low <
      previousLow &&
    current.close >
      previousLow
  ) {

    return "BULLISH";
  }


  /*
    BUY-SIDE LIQUIDITY SWEEP

    Price moves above old highs
    then closes back below them.

    This can support SELL.
  */

  if (
    current.high >
      previousHigh &&
    current.close <
      previousHigh
  ) {

    return "BEARISH";
  }


  return "NONE";
}


/* =========================
   FAIR VALUE GAP
========================= */

function detectFVG(candles) {

  if (
    !candles ||
    candles.length < 3
  ) {
    return "NONE";
  }

  const candle1 =
    candles[
      candles.length - 3
    ];

  const candle3 =
    candles[
      candles.length - 1
    ];


  /*
    BULLISH FVG

    Current candle low
    remains above candle 1 high.
  */

  if (
    candle3.low >
    candle1.high
  ) {

    return "BULLISH";
  }


  /*
    BEARISH FVG

    Current candle high
    remains below candle 1 low.
  */

  if (
    candle3.high <
    candle1.low
  ) {

    return "BEARISH";
  }


  return "NONE";
}


/* =========================
   FETCH MARKET DATA
========================= */

async function getMarketData() {

  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY missing"
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
    data.status === "error" ||
    !Array.isArray(data.values)
  ) {

    throw new Error(
      data.message ||
      "Market API error"
    );
  }

  const candles =
    data.values
      .map(item => ({
        datetime:
          item.datetime,

        open:
          Number(item.open),

        high:
          Number(item.high),

        low:
          Number(item.low),

        close:
          Number(item.close)
      }))
      .reverse();

  return candles;
}


/* =========================
   ANALYZE MARKET
========================= */

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


  const m5Closes =
    m5Candles.map(
      c => c.close
    );

  const m15Closes =
    m15Candles.map(
      c => c.close
    );

  const h1Closes =
    h1Candles.map(
      c => c.close
    );


  /* H1 TREND */

  const h1EMA10 =
    ema(h1Closes, 10);

  const h1EMA20 =
    ema(h1Closes, 20);

  let h1Trend =
    "SIDEWAYS";

  if (
    h1EMA10 >
    h1EMA20
  ) {
    h1Trend =
      "BULLISH";
  }

  if (
    h1EMA10 <
    h1EMA20
  ) {
    h1Trend =
      "BEARISH";
  }


  /* M15 CONFIRMATION */

  const m15EMA9 =
    ema(m15Closes, 9);

  const m15EMA21 =
    ema(m15Closes, 21);

  let m15Trend =
    "SIDEWAYS";

  if (
    m15EMA9 >
    m15EMA21
  ) {
    m15Trend =
      "BULLISH";
  }

  if (
    m15EMA9 <
    m15EMA21
  ) {
    m15Trend =
      "BEARISH";
  }


  /* M5 TRIGGER */

  const m5EMA9 =
    ema(m5Closes, 9);

  const m5EMA21 =
    ema(m5Closes, 21);

  const current =
    m5Candles[
      m5Candles.length - 1
    ];

  const previous =
    m5Candles[
      m5Candles.length - 2
    ];

  let m5Trigger =
    "WAIT";


  if (
    m5EMA9 >
      m5EMA21 &&
    current.close >
      current.open &&
    current.close >
      previous.close
  ) {

    m5Trigger =
      "BUY";
  }


  if (
    m5EMA9 <
      m5EMA21 &&
    current.close <
      current.open &&
    current.close <
      previous.close
  ) {

    m5Trigger =
      "SELL";
  }


  /* RSI */

  const rsi =
    calculateRSI(
      m5Closes,
      14
    );


  /* NEW LIQUIDITY SWEEP */

  const liquiditySweep =
    detectLiquiditySweep(
      m5Candles
    );


  /* NEW FVG */

  const fvg =
    detectFVG(
      m5Candles
    );


  /*
     SCORING

     H1       = 30
     M15      = 25
     M5       = 20
     RSI      = 10
     Liquidity= 10
     FVG      = 5

     TOTAL = 100
  */

  let buyScore = 0;

  let sellScore = 0;


  /* H1 */

  if (
    h1Trend ===
    "BULLISH"
  ) {
    buyScore += 30;
  }

  if (
    h1Trend ===
    "BEARISH"
  ) {
    sellScore += 30;
  }


  /* M15 */

  if (
    m15Trend ===
    "BULLISH"
  ) {
    buyScore += 25;
  }

  if (
    m15Trend ===
    "BEARISH"
  ) {
    sellScore += 25;
  }


  /* M5 */

  if (
    m5Trigger ===
    "BUY"
  ) {
    buyScore += 20;
  }

  if (
    m5Trigger ===
    "SELL"
  ) {
    sellScore += 20;
  }


  /* RSI */

  if (
    rsi !== null
  ) {

    if (
      rsi >= 50 &&
      rsi <= 70
    ) {
      buyScore += 10;
    }

    if (
      rsi <= 50 &&
      rsi >= 30
    ) {
      sellScore += 10;
    }
  }


  /* LIQUIDITY */

  if (
    liquiditySweep ===
    "BULLISH"
  ) {
    buyScore += 10;
  }

  if (
    liquiditySweep ===
    "BEARISH"
  ) {
    sellScore += 10;
  }


  /* FVG */

  if (
    fvg ===
    "BULLISH"
  ) {
    buyScore += 5;
  }

  if (
    fvg ===
    "BEARISH"
  ) {
    sellScore += 5;
  }


  buyScore =
    Math.min(
      buyScore,
      100
    );

  sellScore =
    Math.min(
      sellScore,
      100
    );


  let type =
    "WAIT";

  let confidence =
    Math.max(
      buyScore,
      sellScore
    );


  /*
    BUY RULE

    Must:
    - reach 85%
    - have M5 BUY trigger
    - have liquidity sweep
      OR FVG confirmation
  */

  if (
    buyScore >=
      MIN_SIGNAL_CONFIDENCE &&
    buyScore >
      sellScore &&
    m5Trigger ===
      "BUY" &&
    (
      liquiditySweep ===
        "BULLISH" ||
      fvg ===
        "BULLISH"
    )
  ) {

    type =
      "BUY";

    confidence =
      buyScore;
  }


  /*
    SELL RULE
  */

  if (
    sellScore >=
      MIN_SIGNAL_CONFIDENCE &&
    sellScore >
      buyScore &&
    m5Trigger ===
      "SELL" &&
    (
      liquiditySweep ===
        "BEARISH" ||
      fvg ===
        "BEARISH"
    )
  ) {

    type =
      "SELL";

    confidence =
      sellScore;
  }


  /* STOP LOSS & TAKE PROFITS */

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

  const entry =
    current.close;

  let sl = null;

  let tp1 = null;

  let tp2 = null;

  let tp3 = null;


  if (type === "BUY") {

    sl =
      recentLow;

    const risk =
      entry - sl;

    if (risk > 0) {

      tp1 =
        entry + risk;

      tp2 =
        entry +
        risk * 2;

      tp3 =
        entry +
        risk * 3;
    }
  }


  if (type === "SELL") {

    sl =
      recentHigh;

    const risk =
      sl - entry;

    if (risk > 0) {

      tp1 =
        entry - risk;

      tp2 =
        entry -
        risk * 2;

      tp3 =
        entry -
        risk * 3;
    }
  }


  let reason =
    "No strong setup yet";


  if (type === "BUY") {

    reason =
      "Bullish trend with M5 confirmation";

    if (
      liquiditySweep ===
      "BULLISH"
    ) {
      reason +=
        " + liquidity sweep";
    }

    if (
      fvg ===
      "BULLISH"
    ) {
      reason +=
        " + bullish FVG";
    }
  }


  if (type === "SELL") {

    reason =
      "Bearish trend with M5 confirmation";

    if (
      liquiditySweep ===
      "BEARISH"
    ) {
      reason +=
        " + liquidity sweep";
    }

    if (
      fvg ===
      "BEARISH"
    ) {
      reason +=
        " + bearish FVG";
    }
  }


  return {

    price:
      current.close,

    signal: {
      type,
      confidence,
      reason,
      entry,
      sl,
      tp1,
      tp2,
      tp3
    },

    analysis: {
      h1Trend,
      m15Trend,
      m5Trigger,
      liquiditySweep,
      fvg,
      rsi:
        rsi === null
          ? null
          : Number(
              rsi.toFixed(2)
            ),
      buyScore,
      sellScore
    }
  };
}


/* =========================
   BACKGROUND SCANNER
========================= */

async function backgroundScan() {

  /*
    WEEKEND PROTECTION

    Sunday = 0
    Saturday = 6

    NO SCANNING
    NO SIGNALS
    NO NOTIFICATIONS
  */

  const day =
    new Date().getUTCDay();

  if (
    day === 0 ||
    day === 6
  ) {

    console.log(
      "Weekend - Sharp Entry scanner paused"
    );

    state.signal = {
      type: "WAIT",
      confidence: 0,
      reason:
        "Weekend - market scanner paused",
      entry: null,
      sl: null,
      tp1: null,
      tp2: null,
      tp3: null
    };

    state.nextScanAt =
      new Date(
        Date.now() +
        SCAN_INTERVAL_MINUTES *
        60 *
        1000
      ).toISOString();

    return;
  }


  if (state.scanning) {
    return;
  }


  state.scanning = true;

  state.lastError = null;


  try {

    console.log(
      `Scanning ${SYMBOL}...`
    );

    const candles =
      await getMarketData();

    const result =
      analyzeMarket(
        candles
      );


    state.market = {

      symbol:
        SYMBOL,

      price:
        result.price,

      updatedAt:
        new Date().toISOString()
    };


    state.signal =
      result.signal;

    state.analysis =
      result.analysis;

    state.lastScanAt =
      new Date().toISOString();


    /*
      SAVE ONLY
      REAL BUY/SELL SIGNALS
    */

    if (
      result.signal.type ===
        "BUY" ||
      result.signal.type ===
        "SELL"
    ) {

      const lastSignal =
        history[0];

      let duplicate =
        false;


      if (
        lastSignal &&
        lastSignal.type ===
          result.signal.type
      ) {

        const timeDifference =
          Date.now() -
          new Date(
            lastSignal.time
          ).getTime();

        if (
          timeDifference <
          15 *
          60 *
          1000
        ) {

          duplicate =
            true;
        }
      }


      if (!duplicate) {

        const record = {

          time:
            new Date()
              .toISOString(),

          symbol:
            SYMBOL,

          type:
            result.signal.type,

          confidence:
            result.signal
              .confidence,

          entry:
            result.signal.entry,

          sl:
            result.signal.sl,

          tp1:
            result.signal.tp1,

          tp2:
            result.signal.tp2,

          tp3:
            result.signal.tp3,

          liquiditySweep:
            result.analysis
              .liquiditySweep,

          fvg:
            result.analysis.fvg,

          rsi:
            result.analysis.rsi
        };


        history.unshift(
          record
        );


        history =
          history.slice(
            0,
            100
          );


        saveJSON(
          HISTORY_FILE,
          history
        );


        const message =
          `${result.signal.type} ${SYMBOL}` +
          `\nConfidence: ${result.signal.confidence}%` +
          `\nEntry: ${result.signal.entry}` +
          `\nSL: ${result.signal.sl}` +
          `\nTP1: ${result.signal.tp1}` +
          `\nTP2: ${result.signal.tp2}` +
          `\nTP3: ${result.signal.tp3}` +
          `\nLiquidity: ${result.analysis.liquiditySweep}` +
          `\nFVG: ${result.analysis.fvg}`;


        await sendPushToAll(
          "🔥 Sharp Entry V3",
          message
        );
      }
    }


  } catch (error) {

    state.lastError =
      error.message;

    console.log(
      "Scanner error:",
      error.message
    );

  } finally {

    state.scanning =
      false;

    state.nextScanAt =
      new Date(
        Date.now() +
        SCAN_INTERVAL_MINUTES *
        60 *
        1000
      ).toISOString();
  }
}


/* =========================
   API
========================= */

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      online: true,

      scanning:
        state.scanning,

      lastScanAt:
        state.lastScanAt,

      nextScanAt:
        state.nextScanAt,

      lastError:
        state.lastError,

      market:
        state.market,

      signal:
        state.signal,

      analysis:
        state.analysis,

      minimumConfidence:
        MIN_SIGNAL_CONFIDENCE,

      scanIntervalMinutes:
        SCAN_INTERVAL_MINUTES,

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

    res.json({
      success: true,
      state
    });
  }
);


app.get(
  "/api/vapid-public-key",
  (req, res) => {

    res.json({
      publicKey:
        VAPID_PUBLIC_KEY
    });
  }
);


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


    const alreadyExists =
      subscriptions.some(
        item =>
          item.endpoint ===
          subscription.endpoint
      );


    if (!alreadyExists) {

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


app.post(
  "/api/test-notification",
  async (req, res) => {

    try {

      await sendPushToAll(
        "🔥 Sharp Entry V3",
        "Test successful. Sharp Entry notifications are working."
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


/* =========================
   START AUTOMATIC SCANNER
========================= */

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

    console.log(
      `Automatic scan every ${SCAN_INTERVAL_MINUTES} minutes`
    );

    console.log(
      `Minimum confidence ${MIN_SIGNAL_CONFIDENCE}%`
    );

    console.log(
      "Liquidity Sweep detection ON"
    );

    console.log(
      "FVG detection ON"
    );

    console.log(
      "Weekend trading OFF"
    );
  }
);
