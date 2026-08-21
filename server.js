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

/*
  IMPORTANT:
  85 is now only the minimum AI/filter quality.
  The sharp-entry engine must confirm the setup FIRST.
*/
const MIN_SIGNAL_CONFIDENCE = 85;
const MAX_DISPLAY_CONFIDENCE = 95;

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

  activeTrade: null,

  invalidatedSetupKey: null,

  history: loadHistory()
};

let lastNotificationKey = "";


/* =========================
   VAPID
========================= */

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


/* =========================
   HISTORY
========================= */

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


function addHistory(result) {
  const key =
    result.historyKey ||
    `${result.signal}-${result.candleTime}`;

  const exists =
    state.history.some(
      x => x.key === key
    );

  if (exists) {
    return;
  }

  state.history.unshift({
    key,
    ...result
  });

  state.history =
    state.history.slice(0, 30);

  saveHistory();
}


/* =========================
   INDICATORS
========================= */

function ema(values, period) {
  if (!values.length) {
    return 0;
  }

  const k =
    2 / (period + 1);

  let result =
    values[0];

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


function rsi(
  values,
  period = 14
) {
  if (
    values.length <= period
  ) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i =
      values.length - period;
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

  if (losses === 0) {
    return 100;
  }

  const rs =
    gains / losses;

  return (
    100 -
    100 / (1 + rs)
  );
}


function atr(
  candles,
  period = 14
) {
  if (
    candles.length <
    period + 1
  ) {
    return 0;
  }

  const ranges = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const high =
      Number(candles[i].high);

    const low =
      Number(candles[i].low);

    const prevClose =
      Number(
        candles[i - 1].close
      );

    ranges.push(
      Math.max(
        high - low,
        Math.abs(
          high - prevClose
        ),
        Math.abs(
          low - prevClose
        )
      )
    );
  }

  const recent =
    ranges.slice(-period);

  return (
    recent.reduce(
      (a, b) => a + b,
      0
    ) /
    recent.length
  );
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


/* =========================
   MARKET DATA
========================= */

async function getTimeSeries(
  interval,
  outputsize = 120
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

  const response =
    await fetch(url);

  const data =
    await response.json();

  if (!data.values) {
    throw new Error(
      data.message ||
      "No XAU/USD data received"
    );
  }

  return data.values.reverse();
}


/* =========================
   LIQUIDITY SWEEP
========================= */

function detectLiquiditySweep(
  candles,
  currentATR
) {
  const closed =
    candles.slice(0, -1);

  if (closed.length < 20) {
    return {
      direction: null,
      time: null,
      level: null,
      strength: 0
    };
  }

  /*
    Search recent CLOSED candles.

    SELL-SIDE sweep:
    Price trades below previous lows,
    then closes back above that liquidity.

    BUY-SIDE sweep:
    Price trades above previous highs,
    then closes back below that liquidity.
  */

  const start =
    Math.max(
      10,
      closed.length - 12
    );

  for (
    let i =
      closed.length - 1;
    i >= start;
    i--
  ) {
    const candle =
      closed[i];

    const previous =
      closed.slice(
        Math.max(0, i - 10),
        i
      );

    if (previous.length < 5) {
      continue;
    }

    const previousLow =
      Math.min(
        ...previous.map(
          c => Number(c.low)
        )
      );

    const previousHigh =
      Math.max(
        ...previous.map(
          c => Number(c.high)
        )
      );

    const low =
      Number(candle.low);

    const high =
      Number(candle.high);

    const close =
      Number(candle.close);

    const open =
      Number(candle.open);

    const tolerance =
      Math.max(
        currentATR * 0.05,
        close * 0.00005
      );

    /*
      Sell-side liquidity sweep
      can prepare a BUY.
    */

    if (
      low <
        previousLow -
        tolerance &&
      close >
        previousLow
    ) {
      const bullishReaction =
        close > open;

      return {
        direction:
          "SELL_SIDE",

        expectedDirection:
          "BULLISH",

        time:
          candle.datetime,

        level:
          previousLow,

        strength:
          bullishReaction
            ? 20
            : 15
      };
    }

    /*
      Buy-side liquidity sweep
      can prepare a SELL.
    */

    if (
      high >
        previousHigh +
        tolerance &&
      close <
        previousHigh
    ) {
      const bearishReaction =
        close < open;

      return {
        direction:
          "BUY_SIDE",

        expectedDirection:
          "BEARISH",

        time:
          candle.datetime,

        level:
          previousHigh,

        strength:
          bearishReaction
            ? 20
            : 15
      };
    }
  }

  return {
    direction: null,
    expectedDirection: null,
    time: null,
    level: null,
    strength: 0
  };
}


/* =========================
   BOS DETECTION
========================= */

function findRecentBOS(
  candles
) {
  const closed =
    candles.slice(0, -1);

  if (
    closed.length < 25
  ) {
    return {
      direction: null,
      level: null,
      time: null,
      index: null
    };
  }

  for (
    let i =
      closed.length - 1;
    i >=
      Math.max(
        12,
        closed.length - 10
      );
    i--
  ) {
    const candle =
      closed[i];

    const close =
      Number(candle.close);

    const previous =
      closed.slice(
        i - 10,
        i
      );

    const priorHigh =
      Math.max(
        ...previous.map(
          c => Number(c.high)
        )
      );

    const priorLow =
      Math.min(
        ...previous.map(
          c => Number(c.low)
        )
      );

    if (
      close > priorHigh
    ) {
      return {
        direction:
          "BULLISH",

        level:
          priorHigh,

        time:
          candle.datetime,

        index:
          i
      };
    }

    if (
      close < priorLow
    ) {
      return {
        direction:
          "BEARISH",

        level:
          priorLow,

        time:
          candle.datetime,

        index:
          i
      };
    }
  }

  return {
    direction: null,
    level: null,
    time: null,
    index: null
  };
}


/* =========================
   RETEST DETECTION
========================= */

function detectRetest(
  candles,
  bos,
  currentATR
) {
  if (
    !bos.direction ||
    bos.index === null
  ) {
    return {
      confirmed: false,
      quality: 0,
      time: null
    };
  }

  const closed =
    candles.slice(0, -1);

  const afterBos =
    closed.slice(
      bos.index + 1
    );

  if (!afterBos.length) {
    return {
      confirmed: false,
      quality: 0,
      time: null
    };
  }

  const tolerance =
    Math.max(
      currentATR * 0.20,
      bos.level * 0.00015
    );

  for (
    const candle
    of afterBos
  ) {
    const high =
      Number(candle.high);

    const low =
      Number(candle.low);

    const close =
      Number(candle.close);

    if (
      bos.direction ===
      "BULLISH"
    ) {
      const touched =
        low <=
        bos.level +
        tolerance;

      const held =
        close >
        bos.level;

      if (
        touched &&
        held
      ) {
        return {
          confirmed: true,
          quality: 20,
          time:
            candle.datetime
        };
      }
    }

    if (
      bos.direction ===
      "BEARISH"
    ) {
      const touched =
        high >=
        bos.level -
        tolerance;

      const held =
        close <
        bos.level;

      if (
        touched &&
        held
      ) {
        return {
          confirmed: true,
          quality: 20,
          time:
            candle.datetime
        };
      }
    }
  }

  return {
    confirmed: false,
    quality: 0,
    time: null
  };
}


/* =========================
   FAIR VALUE GAP
========================= */

function detectFVG(
  candles,
  direction,
  currentPrice,
  currentATR
) {
  const closed =
    candles.slice(0, -1);

  if (
    closed.length < 5 ||
    !direction
  ) {
    return {
      confirmed: false,
      direction: null,
      low: null,
      high: null,
      time: null,
      score: 0
    };
  }

  /*
    Three-candle FVG.

    Bullish:
    candle 3 low > candle 1 high.

    Bearish:
    candle 3 high < candle 1 low.

    We only search recent gaps because
    old gaps are less useful for a
    sharp current entry.
  */

  const start =
    Math.max(
      2,
      closed.length - 15
    );

  for (
    let i =
      closed.length - 1;
    i >= start;
    i--
  ) {
    const first =
      closed[i - 2];

    const third =
      closed[i];

    if (!first || !third) {
      continue;
    }

    const firstHigh =
      Number(first.high);

    const firstLow =
      Number(first.low);

    const thirdHigh =
      Number(third.high);

    const thirdLow =
      Number(third.low);

    if (
      direction ===
        "BULLISH" &&
      thirdLow >
        firstHigh
    ) {
      const gapLow =
        firstHigh;

      const gapHigh =
        thirdLow;

      const distance =
        currentPrice >
        gapHigh
          ? currentPrice -
            gapHigh
          : currentPrice <
            gapLow
          ? gapLow -
            currentPrice
          : 0;

      const nearGap =
        distance <=
        Math.max(
          currentATR * 0.60,
          currentPrice *
            0.0004
        );

      if (nearGap) {
        return {
          confirmed: true,
          direction:
            "BULLISH",
          low:
            gapLow,
          high:
            gapHigh,
          time:
            third.datetime,
          score: 15
        };
      }
    }

    if (
      direction ===
        "BEARISH" &&
      thirdHigh <
        firstLow
    ) {
      const gapLow =
        thirdHigh;

      const gapHigh =
        firstLow;

      const distance =
        currentPrice >
        gapHigh
          ? currentPrice -
            gapHigh
          : currentPrice <
            gapLow
          ? gapLow -
            currentPrice
          : 0;

      const nearGap =
        distance <=
        Math.max(
          currentATR * 0.60,
          currentPrice *
            0.0004
        );

      if (nearGap) {
        return {
          confirmed: true,
          direction:
            "BEARISH",
          low:
            gapLow,
          high:
            gapHigh,
          time:
            third.datetime,
          score: 15
        };
      }
    }
  }

  return {
    confirmed: false,
    direction: null,
    low: null,
    high: null,
    time: null,
    score: 0
  };
}


/* =========================
   M5 CONFIRMATION
========================= */

function detectM5Confirmation(
  candles,
  direction,
  m5EMA20,
  currentRSI
) {
  const closed =
    candles.slice(0, -1);

  if (
    closed.length < 3
  ) {
    return {
      confirmed: false,
      score: 0
    };
  }

  const last =
    closed[
      closed.length - 1
    ];

  const previous =
    closed[
      closed.length - 2
    ];

  const open =
    Number(last.open);

  const close =
    Number(last.close);

  const high =
    Number(last.high);

  const low =
    Number(last.low);

  const prevOpen =
    Number(previous.open);

  const prevClose =
    Number(previous.close);

  const body =
    Math.abs(
      close - open
    );

  const range =
    Math.max(
      high - low,
      0.00001
    );

  const strongBody =
    body / range >= 0.50;

  if (
    direction ===
    "BULLISH"
  ) {
    const bullish =
      close > open;

    const engulfing =
      close > prevOpen &&
      open <= prevClose;

    const aboveEMA =
      close > m5EMA20;

    const goodRSI =
      currentRSI >= 50 &&
      currentRSI <= 72;

    const confirmed =
      bullish &&
      aboveEMA &&
      goodRSI &&
      (
        strongBody ||
        engulfing
      );

    return {
      confirmed,
      score:
        confirmed
          ? 20
          : 0
    };
  }

  if (
    direction ===
    "BEARISH"
  ) {
    const bearish =
      close < open;

    const engulfing =
      close < prevOpen &&
      open >= prevClose;

    const belowEMA =
      close < m5EMA20;

    const goodRSI =
      currentRSI <= 50 &&
      currentRSI >= 28;

    const confirmed =
      bearish &&
      belowEMA &&
      goodRSI &&
      (
        strongBody ||
        engulfing
      );

    return {
      confirmed,
      score:
        confirmed
          ? 20
          : 0
    };
  }

  return {
    confirmed: false,
    score: 0
  };
}


/* =========================
   LOT SUGGESTION
========================= */

function getLotSuggestion(
  confidence
) {
  if (
    confidence < 85
  ) {
    return "NO TRADE";
  }

  if (
    confidence < 90
  ) {
    return "SMALL";
  }

  if (
    confidence < 93
  ) {
    return "MEDIUM";
  }

  return "STRONG SETUP";
}


/* =========================
   MAIN ANALYSIS
========================= */

async function analyzeGold() {
  state.scanning = true;
  state.lastError = null;

  try {
    const [
      m5,
      m15,
      h1
    ] =
      await Promise.all([
        getTimeSeries(
          "5min",
          120
        ),

        getTimeSeries(
          "15min",
          120
        ),

        getTimeSeries(
          "1h",
          120
        )
      ]);


    const latest =
      m5[
        m5.length - 1
      ];

    const latestClosed =
      m5[
        m5.length - 2
      ];

    const price =
      Number(
        latest.close
      );


    const m5Close =
      m5.map(
        c =>
          Number(c.close)
      );

    const m15Close =
      m15.map(
        c =>
          Number(c.close)
      );

    const h1Close =
      h1.map(
        c =>
          Number(c.close)
      );


    const h1EMA20 =
      ema(
        h1Close.slice(-60),
        20
      );

    const h1EMA50 =
      ema(
        h1Close.slice(-90),
        50
      );


    const m15EMA20 =
      ema(
        m15Close.slice(-60),
        20
      );

    const m15EMA50 =
      ema(
        m15Close.slice(-90),
        50
      );


    const m5EMA20 =
      ema(
        m5Close.slice(-50),
        20
      );


    const currentRSI =
      rsi(
        m5Close,
        14
      );


    const currentATR15 =
      atr(
        m15,
        14
      );


    const h1Trend =
      getTrendLabel(
        h1EMA20,
        h1EMA50
      );


    const m15Trend =
      getTrendLabel(
        m15EMA20,
        m15EMA50
      );


    /*
      SHARP ENTRY ENGINE
    */

    const liquidity =
      detectLiquiditySweep(
        m15,
        currentATR15
      );


    const bos =
      findRecentBOS(
        m15
      );


    const retest =
      detectRetest(
        m15,
        bos,
        currentATR15
      );


    const fvg =
      detectFVG(
        m5,
        bos.direction,
        price,
        currentATR15
      );


    const m5Confirm =
      detectM5Confirmation(
        m5,
        bos.direction,
        m5EMA20,
        currentRSI
      );


    /*
      CHECK THAT LIQUIDITY SWEEP
      AGREES WITH BOS
    */

    const liquidityAligned =
      Boolean(
        liquidity.expectedDirection &&
        bos.direction &&
        liquidity.expectedDirection ===
          bos.direction
      );


    /*
      SWEEP MUST HAPPEN BEFORE
      OR AROUND THE BOS.

      Prevents using a random
      old/new sweep with an
      unrelated structure break.
    */

    let sweepBeforeBos =
      false;

    if (
      liquidity.time &&
      bos.time
    ) {
      const sweepTime =
        new Date(
          liquidity.time
        ).getTime();

      const bosTime =
        new Date(
          bos.time
        ).getTime();

      sweepBeforeBos =
        sweepTime <= bosTime;
    }


    /*
      PRICE MUST NOT BE TOO FAR
      FROM THE BROKEN STRUCTURE.

      This reduces chasing entries.
    */

    let entryNotExtended =
      false;

    if (
      bos.level &&
      currentATR15 > 0
    ) {
      const distance =
        Math.abs(
          price -
          bos.level
        );

      entryNotExtended =
        distance <=
        currentATR15 *
          1.25;
    }


    /*
      RETEST OR FVG

      A sharp setup does not need
      both every single time.

      But it needs at least one
      proper re-entry area.
    */

    const entryZoneConfirmed =
      retest.confirmed ||
      fvg.confirmed;


    /*
      =========================
      AI / QUALITY FILTER

      IMPORTANT:
      This does NOT create trades.
      It only rates a setup that
      the sharp-entry engine found.
      =========================
    */

    let rawScore = 0;

    const reasons = [];


    /*
      LIQUIDITY = 20
    */

    if (
      liquidityAligned &&
      sweepBeforeBos
    ) {
      rawScore += 20;

      reasons.push(
        `${liquidity.direction} liquidity sweep confirmed`
      );
    } else {
      reasons.push(
        "Waiting for matching liquidity sweep"
      );
    }


    /*
      BOS = 20
    */

    if (
      bos.direction
    ) {
      rawScore += 20;

      reasons.push(
        `${bos.direction} M15 BOS confirmed`
      );
    } else {
      reasons.push(
        "Waiting for M15 BOS"
      );
    }


    /*
      ENTRY ZONE = 20
    */

    if (
      retest.confirmed
    ) {
      rawScore += 20;

      reasons.push(
        "Broken structure retested and held"
      );
    } else if (
      fvg.confirmed
    ) {
      rawScore += 20;

      reasons.push(
        `${fvg.direction} FVG entry zone confirmed`
      );
    } else {
      reasons.push(
        "Waiting for retest or FVG entry zone"
      );
    }


    /*
      M5 CONFIRMATION = 20
    */

    if (
      m5Confirm.confirmed
    ) {
      rawScore += 20;

      reasons.push(
        "M5 sharp entry confirmation"
      );
    } else {
      reasons.push(
        "Waiting for M5 confirmation"
      );
    }


    /*
      H1 FILTER = 10
    */

    if (
      bos.direction &&
      h1Trend ===
        bos.direction
    ) {
      rawScore += 10;

      reasons.push(
        "H1 trend agrees"
      );
    } else {
      reasons.push(
        "H1 trend not aligned"
      );
    }


    /*
      M15 FILTER = 5
    */

    if (
      bos.direction &&
      m15Trend ===
        bos.direction
    ) {
      rawScore += 5;

      reasons.push(
        "M15 trend agrees"
      );
    }


    /*
      ENTRY LOCATION = 5
    */

    if (
      entryNotExtended
    ) {
      rawScore += 5;

      reasons.push(
        "Entry is still close to structure"
      );
    } else {
      reasons.push(
        "Price has moved too far from sharp-entry area"
      );
    }


    /*
      Maximum DISPLAY score is 95.

      95 does NOT mean a 95%
      guaranteed win rate.
    */

    const confidence =
      Math.min(
        MAX_DISPLAY_CONFIDENCE,
        rawScore
      );


    /*
      =========================
      SHARP ENTRY GATE

      THIS decides whether a
      BUY/SELL is allowed.

      Score cannot override it.
      =========================
    */

    const sharpEntryConfirmed =
      Boolean(
        liquidityAligned &&
        sweepBeforeBos &&
        bos.direction &&
        entryZoneConfirmed &&
        m5Confirm.confirmed &&
        entryNotExtended
      );


    /*
      AI FILTER

      After sharp entry exists,
      trend + scoring decides
      whether quality is enough.
    */

    const aiFilterPassed =
      Boolean(
        confidence >=
          MIN_SIGNAL_CONFIDENCE &&
        h1Trend ===
          bos.direction
      );


    let signal =
      "WAIT";

    let action =
      "WAIT FOR SHARP ENTRY";


    const setupKey =
      bos.direction
        ? `${bos.direction}-${bos.time}`
        : null;


    if (
      sharpEntryConfirmed &&
      aiFilterPassed &&
      setupKey !==
        state.invalidatedSetupKey
    ) {
      signal =
        bos.direction ===
        "BULLISH"
          ? "BUY"
          : "SELL";

      action =
        "SHARP ENTRY CONFIRMED";
    } else if (
      sharpEntryConfirmed &&
      !aiFilterPassed
    ) {
      action =
        "SHARP SETUP FOUND — AI FILTER REJECTED";
    }


    /*
      STRUCTURE LEVELS
    */

    let sl = null;
    let tp1 = null;
    let tp2 = null;
    let tp3 = null;


    const recentM5 =
      m5.slice(
        -12,
        -1
      );


    const recentLow =
      Math.min(
        ...recentM5.map(
          c =>
            Number(c.low)
        )
      );


    const recentHigh =
      Math.max(
        ...recentM5.map(
          c =>
            Number(c.high)
        )
      );


    if (
      signal === "BUY"
    ) {
      sl = recentLow;

      const risk =
        price - sl;

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


    if (
      signal === "SELL"
    ) {
      sl = recentHigh;

      const risk =
        sl - price;

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


    /*
      ACTIVE TRADE
      MARKET CHANGE MONITOR
    */

    let tradeStatus =
      state.activeTrade
        ? "ACTIVE"
        : "WAITING";


    if (
      state.activeTrade
    ) {
      const direction =
        state.activeTrade.signal;

      /*
        IMPORTANT:
        Use the structure level saved
        when the trade was created.

        Do not use a completely new BOS
        to invalidate an old trade.
      */

      const tradeBosLevel =
        state.activeTrade.bosLevel;


      const bullishInvalidation =
        direction === "BUY" &&
        (
          h1Trend ===
            "BEARISH" ||
          (
            tradeBosLevel &&
            price <
              tradeBosLevel -
              currentATR15 *
                0.25
          )
        );


      const bearishInvalidation =
        direction === "SELL" &&
        (
          h1Trend ===
            "BULLISH" ||
          (
            tradeBosLevel &&
            price >
              tradeBosLevel +
              currentATR15 *
                0.25
          )
        );


      if (
        bullishInvalidation ||
        bearishInvalidation
      ) {
        signal =
          "EXIT";

        action =
          "MARKET CHANGED — EXIT & WAIT";

        tradeStatus =
          "INVALIDATED";

        reasons.unshift(
          "Previous sharp-entry setup is no longer valid"
        );


        state.invalidatedSetupKey =
          state.activeTrade.setupKey;


        state.activeTrade =
          null;
      }
    }


    /*
      REGISTER NEW ACTIVE TRADE
    */

    if (
      signal === "BUY" ||
      signal === "SELL"
    ) {
      if (
        !state.activeTrade
      ) {
        state.activeTrade = {
          signal,
          setupKey,
          entry: price,

          bosLevel:
            bos.level,

          liquidityLevel:
            liquidity.level,

          startedAt:
            new Date()
              .toISOString()
        };
      }

      tradeStatus =
        "ACTIVE";
    }


    const lotSuggestion =
      signal === "BUY" ||
      signal === "SELL"
        ? getLotSuggestion(
            confidence
          )
        : "NO TRADE";


    const chart =
      m5
        .slice(-30)
        .map(c => ({
          time:
            c.datetime,

          close:
            Number(
              c.close
            )
        }));


    const result = {
      signal,

      action,

      tradeStatus,

      confidence,

      confidenceMeaning:
        "SETUP QUALITY — NOT GUARANTEED WIN RATE",

      sharpEntryConfirmed,

      aiFilterPassed,

      setupQuality:
        confidence >= 93
          ? "VERY STRONG"
          : confidence >= 90
          ? "STRONG"
          : confidence >= 85
          ? "QUALIFIED"
          : "WAIT",

      lotSuggestion,

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

      trend:
        h1Trend,

      structure:
        m15Trend,

      h1:
        h1Trend,

      m15:
        m15Trend,

      liquiditySweep:
        liquidity.direction ||
        "WAITING",

      liquidityLevel:
        liquidity.level
          ? Number(
              liquidity.level
                .toFixed(2)
            )
          : null,

      liquidityAligned,

      bos:
        bos.direction ||
        "WAITING",

      bosLevel:
        bos.level
          ? Number(
              bos.level.toFixed(2)
            )
          : null,

      retest:
        retest.confirmed
          ? "CONFIRMED"
          : "WAITING",

      fvg:
        fvg.confirmed
          ? "CONFIRMED"
          : "WAITING",

      fvgLow:
        fvg.low === null
          ? null
          : Number(
              fvg.low.toFixed(2)
            ),

      fvgHigh:
        fvg.high === null
          ? null
          : Number(
              fvg.high.toFixed(2)
            ),

      m5Confirmation:
        m5Confirm.confirmed
          ? "CONFIRMED"
          : "WAITING",

      entryLocation:
        entryNotExtended
          ? "GOOD"
          : "EXTENDED",

      rsi:
        Number(
          currentRSI
            .toFixed(2)
        ),

      reasons,

      chart,

      setupKey,

      candleTime:
        latestClosed.datetime,

      scannedAt:
        new Date()
          .toISOString()
    };


    state.market = {
      symbol:
        "XAU/USD",

      price,

      updatedAt:
        new Date()
          .toISOString()
    };


    state.signal =
      result;


    state.lastScanAt =
      new Date()
        .toISOString();


    /*
      SAVE REAL SIGNALS
      AND EXITS ONLY
    */

    if (
      signal === "BUY" ||
      signal === "SELL" ||
      signal === "EXIT"
    ) {
      result.historyKey =
        `${signal}-${setupKey}-${latestClosed.datetime}`;

      addHistory(
        result
      );
    }


    return result;

  } catch (error) {
    state.lastError =
      error.message;

    throw error;

  } finally {
    state.scanning =
      false;
  }
}


/* =========================
   PUSH NOTIFICATIONS
========================= */

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


  subscriptions =
    survivors;
}


/* =========================
   BACKGROUND SCAN
========================= */

async function backgroundScan() {
  try {
    const result =
      await analyzeGold();


    if (
      result.signal !== "BUY" &&
      result.signal !== "SELL" &&
      result.signal !== "EXIT"
    ) {
      return;
    }


    const notificationKey =
      `${result.signal}-${result.setupKey}-${result.candleTime}`;


    if (
      notificationKey ===
      lastNotificationKey
    ) {
      return;
    }


    lastNotificationKey =
      notificationKey;


    if (
      result.signal ===
      "EXIT"
    ) {
      await sendPushToAll(

        "⚠️ Sharp Entry V3 — MARKET CHANGED",

        "Previous setup invalidated.\nEXIT TRADE and WAIT for another sharp entry."
      );

      return;
    }


    await sendPushToAll(

      `🔥 Sharp Entry V3 — ${result.signal}`,

      `XAU/USD
Setup Quality: ${result.confidence}/95
Rating: ${result.setupQuality}

Entry: ${result.entry}
SL: ${result.sl}
TP1: ${result.tp1}
TP2: ${result.tp2}
TP3: ${result.tp3}

Liquidity: ${result.liquiditySweep}
BOS: ${result.bos}
Retest: ${result.retest}
FVG: ${result.fvg}
M5: ${result.m5Confirmation}`
    );

  } catch (error) {
    console.log(
      "Background scan error:",
      error.message
    );
  }
}


/* =========================
   WEBSITE
========================= */

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


/* =========================
   HEALTH
========================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status:
        "online",

      scanner:
        "Sharp Entry V3 Hybrid",

      market:
        state.market,

      signal:
        state.signal,

      activeTrade:
        state.activeTrade
    });
  }
);


/* =========================
   STATUS
========================= */

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

      activeTrade:
        state.activeTrade,

      lastScanAt:
        state.lastScanAt,

      lastError:
        state.lastError,

      config: {
        intervalMinutes:
          SCAN_INTERVAL_MINUTES,

        minimumConfidence:
          MIN_SIGNAL_CONFIDENCE,

        maximumDisplayConfidence:
          MAX_DISPLAY_CONFIDENCE,

        strategy:
          "LIQUIDITY + BOS + RETEST/FVG + M5 + AI FILTER",

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


/* =========================
   MANUAL SCAN
========================= */

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
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);


app.get(
  "/api/scan",
  async (req, res) => {
    try {
      const result =
        await analyzeGold();

      res.json(
        result
      );

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
   HISTORY
========================= */

app.get(
  "/api/history",
  (req, res) => {
    res.json({
      history:
        state.history
    });
  }
);


/* =========================
   VAPID PUBLIC KEY
========================= */

app.get(
  "/api/vapid-public-key",
  (req, res) => {
    if (
      !VAPID_PUBLIC_KEY
    ) {
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


/* =========================
   PUSH SUBSCRIBE
========================= */

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


    res
      .status(201)
      .json({
        success:
          true
      });
  }
);


/* =========================
   TEST PUSH
========================= */

app.post(
  "/api/test-notification",
  async (req, res) => {
    try {
      await sendPushToAll(

        "🔥 Sharp Entry V3",

        "Test successful. Sharp Entry notifications are working."
      );


      res.json({
        success:
          true
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
   START SCANNER
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
      `Sharp Entry V3 Hybrid running on port ${PORT}`
    );
  }
);
