const express = require("express");
const path = require("path");
const fs = require("fs");
const webpush = require("web-push");

const app = express();

const PORT =
  process.env.PORT || 3000;

const API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || "";

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "";

const VAPID_EMAIL =
  process.env.VAPID_EMAIL ||
  "mailto:admin@example.com";

const SCAN_INTERVAL_MINUTES = 5;

const HISTORY_FILE =
  path.join(
    __dirname,
    "signal-history.json"
  );

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* ==========================
   PUSH NOTIFICATIONS
========================== */

let subscriptions = [];

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

/* ==========================
   HISTORY
========================== */

function loadHistory() {
  try {
    if (
      !fs.existsSync(
        HISTORY_FILE
      )
    ) {
      return [];
    }

    const data =
      fs.readFileSync(
        HISTORY_FILE,
        "utf8"
      );

    return JSON.parse(data);
  } catch (error) {
    console.log(
      "History load error:",
      error.message
    );

    return [];
  }
}

function saveHistory(history) {
  try {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(
        history,
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

/* ==========================
   STATE
========================== */

let state = {
  scanning: false,

  lastScanAt: null,

  lastError: null,

  market: {
    symbol: "XAU/USD",
    price: null,
    updatedAt: null
  },

  signal: {
    type: "WAIT",

    confidence: 0,

    entry: null,

    reason:
      "Waiting for Sharp Entry setup",

    updatedAt: null
  },

  history: loadHistory()
};

/* ==========================
   GET GOLD MARKET DATA
========================== */

async function getMarketData() {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=XAU/USD" +
    "&interval=5min" +
    "&outputsize=100" +
    `&apikey=${API_KEY}`;

  const response =
    await fetch(url);

  const data =
    await response.json();

  if (
    data.status === "error" ||
    !data.values
  ) {
    throw new Error(
      data.message ||
      "Failed to get XAU/USD data"
    );
  }

  return data.values
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
}

/* ==========================
   SHARP ENTRY FUNCTIONS
========================== */

function bullishCandle(candle) {
  return (
    candle.close >
    candle.open
  );
}

function bearishCandle(candle) {
  return (
    candle.close <
    candle.open
  );
}

function candleBody(candle) {
  return Math.abs(
    candle.close -
    candle.open
  );
}

/* ==========================
   SUPPORT / RESISTANCE
========================== */

function findStructure(candles) {
  const recent =
    candles.slice(-25, -2);

  const resistance =
    Math.max(
      ...recent.map(
        candle => candle.high
      )
    );

  const support =
    Math.min(
      ...recent.map(
        candle => candle.low
      )
    );

  return {
    resistance,
    support
  };
}

/* ==========================
   LIQUIDITY SWEEP
========================== */

function detectLiquiditySweep(
  candles,
  support,
  resistance
) {
  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  /*
    SELL-SIDE liquidity sweep:
    price trades below support
    then closes back above.
  */

  const bullishSweep =
    (
      current.low <
        support &&
      current.close >
        support
    ) ||
    (
      previous.low <
        support &&
      previous.close >
        support
    );

  /*
    BUY-SIDE liquidity sweep:
    price trades above resistance
    then closes back below.
  */

  const bearishSweep =
    (
      current.high >
        resistance &&
      current.close <
        resistance
    ) ||
    (
      previous.high >
        resistance &&
      previous.close <
        resistance
    );

  return {
    bullishSweep,
    bearishSweep
  };
}

/* ==========================
   BREAK OF STRUCTURE
========================== */

function detectBOS(candles) {
  const current =
    candles[
      candles.length - 1
    ];

  const previousStructure =
    candles.slice(-12, -2);

  const structureHigh =
    Math.max(
      ...previousStructure.map(
        candle => candle.high
      )
    );

  const structureLow =
    Math.min(
      ...previousStructure.map(
        candle => candle.low
      )
    );

  const bullishBOS =
    current.close >
    structureHigh;

  const bearishBOS =
    current.close <
    structureLow;

  return {
    bullishBOS,
    bearishBOS,
    structureHigh,
    structureLow
  };
}

/* ==========================
   RETEST
========================== */

function detectRetest(
  candles,
  structureHigh,
  structureLow
) {
  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  /*
    Bullish retest:
    previous candle broke higher
    and current candle touched
    structure then closed above.
  */

  const bullishRetest =
    (
      previous.close >
        structureHigh &&
      current.low <=
        structureHigh &&
      current.close >
        structureHigh
    );

  /*
    Bearish retest:
    previous candle broke lower
    and current candle touched
    structure then closed below.
  */

  const bearishRetest =
    (
      previous.close <
        structureLow &&
      current.high >=
        structureLow &&
      current.close <
        structureLow
    );

  return {
    bullishRetest,
    bearishRetest
  };
}

/* ==========================
   CANDLE CONFIRMATION
========================== */

function candleConfirmation(
  candles
) {
  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const currentBody =
    candleBody(current);

  const previousBody =
    candleBody(previous);

  const bullishConfirmation =
    bullishCandle(current) &&
    current.close >
      previous.close &&
    currentBody >=
      previousBody * 0.7;

  const bearishConfirmation =
    bearishCandle(current) &&
    current.close <
      previous.close &&
    currentBody >=
      previousBody * 0.7;

  return {
    bullishConfirmation,
    bearishConfirmation
  };
}

/* ==========================
   SHARP ENTRY STRATEGY
========================== */

function analyzeSharpEntry(
  candles
) {
  if (
    !candles ||
    candles.length < 30
  ) {
    return {
      type: "WAIT",

      confidence: 0,

      entry: null,

      reason:
        "Not enough market data"
    };
  }

  const current =
    candles[
      candles.length - 1
    ];

  const {
    resistance,
    support
  } =
    findStructure(candles);

  const {
    bullishSweep,
    bearishSweep
  } =
    detectLiquiditySweep(
      candles,
      support,
      resistance
    );

  const {
    bullishBOS,
    bearishBOS,
    structureHigh,
    structureLow
  } =
    detectBOS(candles);

  const {
    bullishRetest,
    bearishRetest
  } =
    detectRetest(
      candles,
      structureHigh,
      structureLow
    );

  const {
    bullishConfirmation,
    bearishConfirmation
  } =
    candleConfirmation(
      candles
    );

  let buyScore = 0;
  let sellScore = 0;

  const buyReasons = [];
  const sellReasons = [];

  /* ==========================
     BUY SHARP ENTRY
  ========================== */

  if (bullishSweep) {
    buyScore += 25;

    buyReasons.push(
      "Liquidity sweep"
    );
  }

  if (bullishBOS) {
    buyScore += 30;

    buyReasons.push(
      "Bullish BOS"
    );
  }

  if (bullishRetest) {
    buyScore += 25;

    buyReasons.push(
      "Bullish retest"
    );
  }

  if (
    bullishConfirmation
  ) {
    buyScore += 20;

    buyReasons.push(
      "Bullish confirmation"
    );
  }

  /* ==========================
     SELL SHARP ENTRY
  ========================== */

  if (bearishSweep) {
    sellScore += 25;

    sellReasons.push(
      "Liquidity sweep"
    );
  }

  if (bearishBOS) {
    sellScore += 30;

    sellReasons.push(
      "Bearish BOS"
    );
  }

  if (bearishRetest) {
    sellScore += 25;

    sellReasons.push(
      "Bearish retest"
    );
  }

  if (
    bearishConfirmation
  ) {
    sellScore += 20;

    sellReasons.push(
      "Bearish confirmation"
    );
  }

  /* ==========================
     FINAL SIGNAL
  ========================== */

  let type = "WAIT";

  let confidence =
    Math.max(
      buyScore,
      sellScore
    );

  let reason =
    "Waiting for Sharp Entry confirmation";

  /*
    No signal unless several
    Sharp Entry conditions agree.
  */

  if (
    buyScore >= 70 &&
    buyScore >
      sellScore
  ) {
    type = "BUY";

    confidence =
      Math.min(
        buyScore,
        100
      );

    reason =
      buyReasons.join(
        " + "
      );
  } else if (
    sellScore >= 70 &&
    sellScore >
      buyScore
  ) {
    type = "SELL";

    confidence =
      Math.min(
        sellScore,
        100
      );

    reason =
      sellReasons.join(
        " + "
      );
  }

  return {
    type,

    confidence,

    entry:
      Number(
        current.close.toFixed(
          2
        )
      ),

    reason,

    support:
      Number(
        support.toFixed(2)
      ),

    resistance:
      Number(
        resistance.toFixed(2)
      )
  };
}

/* ==========================
   PUSH
========================== */

async function sendPushToAll(
  title,
  message
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
      body: message
    });

  const active = [];

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

      active.push(
        subscription
      );
    } catch (error) {
      console.log(
        "Push error:",
        error.message
      );
    }
  }

  subscriptions = active;
}

/* ==========================
   BACKGROUND SCANNER
========================== */

async function backgroundScan() {
  if (state.scanning) {
    return;
  }

  state.scanning = true;

  state.lastError = null;

  try {
    const candles =
      await getMarketData();

    const latest =
      candles[
        candles.length - 1
      ];

    state.market = {
      symbol:
        "XAU/USD",

      price:
        Number(
          latest.close.toFixed(
            2
          )
        ),

      updatedAt:
        new Date()
          .toISOString()
    };

    const oldSignal =
      state.signal.type;

    const result =
      analyzeSharpEntry(
        candles
      );

    state.signal = {
      ...result,

      updatedAt:
        new Date()
          .toISOString()
    };

    /*
      Save new BUY/SELL signal.
    */

    if (
      result.type === "BUY" ||
      result.type === "SELL"
    ) {
      /*
        Prevent repeated identical
        notifications every scan.
      */

      if (
        oldSignal !==
        result.type
      ) {
        const signal = {
          id:
            Date.now(),

          symbol:
            "XAU/USD",

          type:
            result.type,

          confidence:
            result.confidence,

          entry:
            result.entry,

          reason:
            result.reason,

          time:
            new Date()
              .toISOString()
        };

        state.history.unshift(
          signal
        );

        state.history =
          state.history.slice(
            0,
            30
          );

        saveHistory(
          state.history
        );

        await sendPushToAll(
          `🔥 SHARP ENTRY ${result.type}`,

          `XAU/USD ${result.type} | Entry ${result.entry} | Confidence ${result.confidence}%`
        );
      }
    }

    state.lastScanAt =
      new Date()
        .toISOString();
  } catch (error) {
    console.log(
      "Scan error:",
      error.message
    );

    state.lastError =
      error.message;
  } finally {
    state.scanning = false;
  }
}

/* ==========================
   API
========================== */

app.get(
  "/api/status",
  (req, res) => {
    res.json(state);
  }
);

app.get(
  "/api/history",
  (req, res) => {
    res.json(
      state.history
    );
  }
);

app.post(
  "/api/scan",
  async (req, res) => {
    await backgroundScan();

    res.json(state);
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

/* ==========================
   START BACKGROUND SCANNER
========================== */

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
