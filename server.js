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

/*
  Sharp Entry threshold.
  This is NOT AI confidence.
  It is simply a score showing
  how many ICT conditions agree.
*/

const MIN_SIGNAL_CONFIDENCE = 85;

const HISTORY_FILE =
  path.join(
    __dirname,
    "signal-history.json"
  );

/* ==============================
   EXPRESS
================================ */

app.use(express.json());

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

/*
  Important:
  keeps Railway main URL working.
*/

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

/* ==============================
   PUSH
================================ */

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

/* ==============================
   HISTORY
================================ */

function loadHistory() {

  try {

    if (
      !fs.existsSync(
        HISTORY_FILE
      )
    ) {
      return [];
    }

    return JSON.parse(
      fs.readFileSync(
        HISTORY_FILE,
        "utf8"
      )
    );

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

/* ==============================
   APP STATE
================================ */

let state = {

  scanning: false,

  lastScanAt: null,

  lastError: null,

  market: {

    symbol:
      "XAU/USD",

    price:
      null,

    updatedAt:
      null

  },

  timeframes: {

    H1: {
      bias: "WAIT"
    },

    M30: {
      bias: "WAIT"
    },

    M15: {
      setup: "WAIT"
    },

    M5: {
      entry: "WAIT"
    }

  },

  signal: {

    type:
      "WAIT",

    confidence:
      0,

    entry:
      null,

    sl:
      null,

    tp1:
      null,

    tp2:
      null,

    tp3:
      null,

    reason:
      "Waiting for ICT confirmation",

    updatedAt:
      null

  },

  history:
    loadHistory()

};

/* ==============================
   MARKET DATA
================================ */

async function fetchCandles(
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

  if (
    data.status === "error" ||
    !data.values
  ) {

    throw new Error(
      data.message ||
      `Could not load ${interval} data`
    );

  }

  return data.values
    .map(
      candle => ({

        datetime:
          candle.datetime,

        open:
          Number(
            candle.open
          ),

        high:
          Number(
            candle.high
          ),

        low:
          Number(
            candle.low
          ),

        close:
          Number(
            candle.close
          )

      })
    )
    .reverse();

}

/* ==============================
   BASIC HELPERS
================================ */

function bullish(candle) {

  return (
    candle.close >
    candle.open
  );

}

function bearish(candle) {

  return (
    candle.close <
    candle.open
  );

}

function bodySize(candle) {

  return Math.abs(
    candle.close -
    candle.open
  );

}

function candleRange(candle) {

  return Math.max(
    candle.high -
    candle.low,
    0.01
  );

}

function roundPrice(value) {

  if (
    value === null ||
    value === undefined ||
    Number.isNaN(value)
  ) {
    return null;
  }

  return Number(
    value.toFixed(2)
  );

}

/* ==============================
   SWING HIGH / LOW
================================ */

function findSwingHighs(
  candles,
  lookback = 2
) {

  const swings = [];

  for (
    let i = lookback;
    i <
    candles.length - lookback;
    i++
  ) {

    let isSwing = true;

    for (
      let j = 1;
      j <= lookback;
      j++
    ) {

      if (
        candles[i].high <=
          candles[i - j].high ||
        candles[i].high <=
          candles[i + j].high
      ) {

        isSwing = false;
        break;

      }
    }

    if (isSwing) {

      swings.push({

        index: i,

        price:
          candles[i].high,

        candle:
          candles[i]

      });

    }
  }

  return swings;
}

function findSwingLows(
  candles,
  lookback = 2
) {

  const swings = [];

  for (
    let i = lookback;
    i <
    candles.length - lookback;
    i++
  ) {

    let isSwing = true;

    for (
      let j = 1;
      j <= lookback;
      j++
    ) {

      if (
        candles[i].low >=
          candles[i - j].low ||
        candles[i].low >=
          candles[i + j].low
      ) {

        isSwing = false;
        break;

      }
    }

    if (isSwing) {

      swings.push({

        index: i,

        price:
          candles[i].low,

        candle:
          candles[i]

      });

    }
  }

  return swings;
}

/* ==============================
   ICT MARKET STRUCTURE
================================ */

function getStructureBias(
  candles
) {

  const highs =
    findSwingHighs(candles);

  const lows =
    findSwingLows(candles);

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {

    return {
      bias: "WAIT",
      reason:
        "Not enough structure"
    };

  }

  const lastHigh =
    highs[
      highs.length - 1
    ];

  const previousHigh =
    highs[
      highs.length - 2
    ];

  const lastLow =
    lows[
      lows.length - 1
    ];

  const previousLow =
    lows[
      lows.length - 2
    ];

  /*
    ICT-style directional
    structure approximation:

    HH + HL = bullish
    LL + LH = bearish
  */

  const bullishStructure =
    lastHigh.price >
      previousHigh.price &&
    lastLow.price >
      previousLow.price;

  const bearishStructure =
    lastHigh.price <
      previousHigh.price &&
    lastLow.price <
      previousLow.price;

  if (bullishStructure) {

    return {

      bias:
        "BULLISH",

      swingHigh:
        lastHigh.price,

      swingLow:
        lastLow.price,

      reason:
        "Higher High + Higher Low"

    };

  }

  if (bearishStructure) {

    return {

      bias:
        "BEARISH",

      swingHigh:
        lastHigh.price,

      swingLow:
        lastLow.price,

      reason:
        "Lower High + Lower Low"

    };

  }

  return {

    bias:
      "WAIT",

    swingHigh:
      lastHigh.price,

    swingLow:
      lastLow.price,

    reason:
      "Mixed market structure"

  };

}

/* ==============================
   DEALING RANGE
================================ */

function getDealingRange(
  candles
) {

  const recent =
    candles.slice(-30);

  const high =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );

  const low =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );

  const equilibrium =
    (
      high +
      low
    ) / 2;

  const current =
    candles[
      candles.length - 1
    ].close;

  let zone =
    "EQUILIBRIUM";

  if (
    current <
    equilibrium
  ) {
    zone =
      "DISCOUNT";
  }

  if (
    current >
    equilibrium
  ) {
    zone =
      "PREMIUM";
  }

  return {

    high,
    low,
    equilibrium,
    current,
    zone

  };

}

/* ==============================
   LIQUIDITY POOLS
================================ */

function getLiquidityLevels(
  candles
) {

  const highs =
    findSwingHighs(
      candles
    );

  const lows =
    findSwingLows(
      candles
    );

  const recentHighs =
    highs.slice(-5);

  const recentLows =
    lows.slice(-5);

  const buySideLiquidity =
    recentHighs.length
      ? Math.max(
          ...recentHighs.map(
            s => s.price
          )
        )
      : null;

  const sellSideLiquidity =
    recentLows.length
      ? Math.min(
          ...recentLows.map(
            s => s.price
          )
        )
      : null;

  return {

    buySideLiquidity,
    sellSideLiquidity

  };

}

/* ==============================
   LIQUIDITY SWEEP
================================ */

function detectLiquiditySweep(
  candles
) {

  const current =
    candles[
      candles.length - 1
    ];

  const previousRange =
    candles.slice(
      -22,
      -2
    );

  const oldHigh =
    Math.max(
      ...previousRange.map(
        c => c.high
      )
    );

  const oldLow =
    Math.min(
      ...previousRange.map(
        c => c.low
      )
    );

  /*
    Sell-side liquidity sweep:
    wick below old low then
    close back above it.
  */

  const sellSideSweep =
    current.low <
      oldLow &&
    current.close >
      oldLow;

  /*
    Buy-side liquidity sweep:
    wick above old high then
    close back below it.
  */

  const buySideSweep =
    current.high >
      oldHigh &&
    current.close <
      oldHigh;

  return {

    sellSideSweep,

    buySideSweep,

    sweptLow:
      sellSideSweep
        ? current.low
        : null,

    sweptHigh:
      buySideSweep
        ? current.high
        : null,

    oldHigh,

    oldLow

  };

}

/* ==============================
   MSS / STRUCTURE SHIFT
================================ */

function detectMSS(
  candles
) {

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      -15,
      -2
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

  const bullishMSS =
    current.close >
    previousHigh;

  const bearishMSS =
    current.close <
    previousLow;

  return {

    bullishMSS,

    bearishMSS,

    breakHigh:
      previousHigh,

    breakLow:
      previousLow

  };

}

/* ==============================
   DISPLACEMENT
================================ */

function detectDisplacement(
  candles
) {

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      -10,
      -1
    );

  const averageBody =
    previous.reduce(
      (
        total,
        candle
      ) =>
        total +
        bodySize(candle),
      0
    ) /
    previous.length;

  const body =
    bodySize(current);

  /*
    Strong candle body
    compared with recent candles.
  */

  const displacement =
    body >
    averageBody * 1.5;

  return {

    bullishDisplacement:
      displacement &&
      bullish(current),

    bearishDisplacement:
      displacement &&
      bearish(current)

  };

}

/* ==============================
   FAIR VALUE GAP
================================ */

function findFVGs(
  candles
) {

  const bullishFVGs = [];
  const bearishFVGs = [];

  for (
    let i = 2;
    i < candles.length;
    i++
  ) {

    const first =
      candles[i - 2];

    const middle =
      candles[i - 1];

    const third =
      candles[i];

    /*
      Bullish FVG:

      candle 3 low is above
      candle 1 high.
    */

    if (
      third.low >
      first.high
    ) {

      bullishFVGs.push({

        index: i,

        low:
          first.high,

        high:
          third.low,

        midpoint:
          (
            first.high +
            third.low
          ) / 2,

        displacementCandle:
          middle

      });

    }

    /*
      Bearish FVG:

      candle 3 high is below
      candle 1 low.
    */

    if (
      third.high <
      first.low
    ) {

      bearishFVGs.push({

        index: i,

        low:
          third.high,

        high:
          first.low,

        midpoint:
          (
            third.high +
            first.low
          ) / 2,

        displacementCandle:
          middle

      });

    }

  }

  return {

    bullishFVGs,

    bearishFVGs

  };

}

/* ==============================
   RECENT UNMITIGATED FVG
================================ */

function getRecentFVG(
  candles,
  direction
) {

  const {
    bullishFVGs,
    bearishFVGs
  } =
    findFVGs(candles);

  const list =
    direction === "BUY"
      ? bullishFVGs
      : bearishFVGs;

  if (!list.length) {
    return null;
  }

  /*
    Search newest first.
  */

  for (
    let i =
      list.length - 1;
    i >= 0;
    i--
  ) {

    const fvg =
      list[i];

    const candlesAfter =
      candles.slice(
        fvg.index + 1
      );

    let completelyMitigated =
      false;

    for (
      const candle
      of candlesAfter
    ) {

      if (
        direction === "BUY"
      ) {

        if (
          candle.low <=
          fvg.low
        ) {

          completelyMitigated =
            true;

          break;

        }

      } else {

        if (
          candle.high >=
          fvg.high
        ) {

          completelyMitigated =
            true;

          break;

        }

      }

    }

    if (
      !completelyMitigated
    ) {

      return fvg;

    }

  }

  return null;
}

/* ==============================
   FVG RETRACEMENT
================================ */

function priceInsideFVG(
  candle,
  fvg
) {

  if (!fvg) {
    return false;
  }

  return (
    candle.low <=
      fvg.high &&
    candle.high >=
      fvg.low
  );

}

/* ==============================
   M5 ENTRY CONFIRMATION
================================ */

function getM5Entry(
  candles,
  direction
) {

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const fvg =
    getRecentFVG(
      candles,
      direction
    );

  const touchedFVG =
    priceInsideFVG(
      current,
      fvg
    ) ||
    priceInsideFVG(
      previous,
      fvg
    );

  let confirmed =
    false;

  if (
    direction === "BUY"
  ) {

    confirmed =
      touchedFVG &&
      bullish(current) &&
      current.close >
        previous.close;

  } else {

    confirmed =
      touchedFVG &&
      bearish(current) &&
      current.close <
        previous.close;

  }

  return {

    confirmed,

    fvg,

    entry:
      current.close

  };

}

/* ==============================
   ICT TARGETS
================================ */

function calculateTargets(
  direction,
  entry,
  sl,
  m5,
  m15,
  h1
) {

  const risk =
    Math.abs(
      entry -
      sl
    );

  if (
    !risk ||
    risk <= 0
  ) {

    return {

      tp1: null,
      tp2: null,
      tp3: null

    };

  }

  const m5Liquidity =
    getLiquidityLevels(m5);

  const m15Liquidity =
    getLiquidityLevels(m15);

  const h1Liquidity =
    getLiquidityLevels(h1);

  let tp1;
  let tp2;
  let tp3;

  if (
    direction === "BUY"
  ) {

    /*
      Prefer liquidity above price.

      Fallback:
      1R / 2R / 3R
    */

    tp1 =
      m5Liquidity
        .buySideLiquidity >
      entry
        ? m5Liquidity
            .buySideLiquidity
        : entry + risk;

    tp2 =
      m15Liquidity
        .buySideLiquidity >
      tp1
        ? m15Liquidity
            .buySideLiquidity
        : entry +
          risk * 2;

    tp3 =
      h1Liquidity
        .buySideLiquidity >
      tp2
        ? h1Liquidity
            .buySideLiquidity
        : entry +
          risk * 3;

  } else {

    tp1 =
      m5Liquidity
        .sellSideLiquidity <
      entry
        ? m5Liquidity
            .sellSideLiquidity
        : entry - risk;

    tp2 =
      m15Liquidity
        .sellSideLiquidity <
      tp1
        ? m15Liquidity
            .sellSideLiquidity
        : entry -
          risk * 2;

    tp3 =
      h1Liquidity
        .sellSideLiquidity <
      tp2
        ? h1Liquidity
            .sellSideLiquidity
        : entry -
          risk * 3;

  }

  return {

    tp1:
      roundPrice(tp1),

    tp2:
      roundPrice(tp2),

    tp3:
      roundPrice(tp3)

  };

}

/* ==============================
   PURE ICT ANALYSIS
================================ */

function analyzeICT(
  h1,
  m30,
  m15,
  m5
) {

  const h1Structure =
    getStructureBias(h1);

  const m30Structure =
    getStructureBias(m30);

  const m30Range =
    getDealingRange(m30);

  const m15Sweep =
    detectLiquiditySweep(m15);

  const m15MSS =
    detectMSS(m15);

  const m15Displacement =
    detectDisplacement(m15);

  const m15BullishFVG =
    getRecentFVG(
      m15,
      "BUY"
    );

  const m15BearishFVG =
    getRecentFVG(
      m15,
      "SELL"
    );

  const m5Buy =
    getM5Entry(
      m5,
      "BUY"
    );

  const m5Sell =
    getM5Entry(
      m5,
      "SELL"
    );

  let buyScore = 0;
  let sellScore = 0;

  const buyReasons = [];
  const sellReasons = [];

  /* ==========================
     H1 BIAS
  ========================== */

  if (
    h1Structure.bias ===
    "BULLISH"
  ) {

    buyScore += 20;

    buyReasons.push(
      "H1 bullish market structure"
    );

  }

  if (
    h1Structure.bias ===
    "BEARISH"
  ) {

    sellScore += 20;

    sellReasons.push(
      "H1 bearish market structure"
    );

  }

  /* ==========================
     M30 ALIGNMENT
  ========================== */

  if (
    m30Structure.bias ===
    "BULLISH"
  ) {

    buyScore += 10;

    buyReasons.push(
      "M30 bullish structure"
    );

  }

  if (
    m30Structure.bias ===
    "BEARISH"
  ) {

    sellScore += 10;

    sellReasons.push(
      "M30 bearish structure"
    );

  }

  /*
    ICT Premium / Discount.

    Buys preferred in discount.
    Sells preferred in premium.
  */

  if (
    m30Range.zone ===
    "DISCOUNT"
  ) {

    buyScore += 10;

    buyReasons.push(
      "M30 discount pricing"
    );

  }

  if (
    m30Range.zone ===
    "PREMIUM"
  ) {

    sellScore += 10;

    sellReasons.push(
      "M30 premium pricing"
    );

  }

  /* ==========================
     M15 LIQUIDITY SWEEP
  ========================== */

  if (
    m15Sweep.sellSideSweep
  ) {

    buyScore += 15;

    buyReasons.push(
      "M15 sell-side liquidity swept"
    );

  }

  if (
    m15Sweep.buySideSweep
  ) {

    sellScore += 15;

    sellReasons.push(
      "M15 buy-side liquidity swept"
    );

  }

  /* ==========================
     M15 MSS
  ========================== */

  if (
    m15MSS.bullishMSS
  ) {

    buyScore += 15;

    buyReasons.push(
      "M15 bullish MSS"
    );

  }

  if (
    m15MSS.bearishMSS
  ) {

    sellScore += 15;

    sellReasons.push(
      "M15 bearish MSS"
    );

  }

  /* ==========================
     DISPLACEMENT
  ========================== */

  if (
    m15Displacement
      .bullishDisplacement
  ) {

    buyScore += 10;

    buyReasons.push(
      "Bullish displacement"
    );

  }

  if (
    m15Displacement
      .bearishDisplacement
  ) {

    sellScore += 10;

    sellReasons.push(
      "Bearish displacement"
    );

  }

  /* ==========================
     M15 FVG
  ========================== */

  if (
    m15BullishFVG
  ) {

    buyScore += 10;

    buyReasons.push(
      "M15 bullish FVG"
    );

  }

  if (
    m15BearishFVG
  ) {

    sellScore += 10;

    sellReasons.push(
      "M15 bearish FVG"
    );

  }

  /* ==========================
     M5 ENTRY
  ========================== */

  if (
    m5Buy.confirmed
  ) {

    buyScore += 10;

    buyReasons.push(
      "M5 FVG retracement + bullish confirmation"
    );

  }

  if (
    m5Sell.confirmed
  ) {

    sellScore += 10;

    sellReasons.push(
      "M5 FVG retracement + bearish confirmation"
    );

  }

  let type =
    "WAIT";

  let confidence =
    Math.max(
      buyScore,
      sellScore
    );

  let reason =
    "Waiting for ICT confirmation";

  let entry =
    m5[
      m5.length - 1
    ].close;

  let sl = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  /* ==========================
     BUY
  ========================== */

  if (
    buyScore >=
      MIN_SIGNAL_CONFIDENCE &&
    buyScore >
      sellScore &&
    h1Structure.bias ===
      "BULLISH" &&
    m5Buy.confirmed
  ) {

    type =
      "BUY";

    confidence =
      Math.min(
        buyScore,
        100
      );

    entry =
      m5Buy.entry;

    /*
      SL below the recent
      sell-side liquidity / swing.
    */

    const recentLow =
      Math.min(
        ...m5
          .slice(-20)
          .map(
            c => c.low
          )
      );

    const range =
      getDealingRange(m5);

    const buffer =
      (
        range.high -
        range.low
      ) * 0.05;

    sl =
      recentLow -
      buffer;

    const targets =
      calculateTargets(
        "BUY",
        entry,
        sl,
        m5,
        m15,
        h1
      );

    tp1 =
      targets.tp1;

    tp2 =
      targets.tp2;

    tp3 =
      targets.tp3;

    reason =
      buyReasons.join(
        " • "
      );

  }

  /* ==========================
     SELL
  ========================== */

  else if (
    sellScore >=
      MIN_SIGNAL_CONFIDENCE &&
    sellScore >
      buyScore &&
    h1Structure.bias ===
      "BEARISH" &&
    m5Sell.confirmed
  ) {

    type =
      "SELL";

    confidence =
      Math.min(
        sellScore,
        100
      );

    entry =
      m5Sell.entry;

    const recentHigh =
      Math.max(
        ...m5
          .slice(-20)
          .map(
            c => c.high
          )
      );

    const range =
      getDealingRange(m5);

    const buffer =
      (
        range.high -
        range.low
      ) * 0.05;

    sl =
      recentHigh +
      buffer;

    const targets =
      calculateTargets(
        "SELL",
        entry,
        sl,
        m5,
        m15,
        h1
      );

    tp1 =
      targets.tp1;

    tp2 =
      targets.tp2;

    tp3 =
      targets.tp3;

    reason =
      sellReasons.join(
        " • "
      );

  }

  return {

    type,

    confidence,

    entry:
      roundPrice(entry),

    sl:
      roundPrice(sl),

    tp1:
      roundPrice(tp1),

    tp2:
      roundPrice(tp2),

    tp3:
      roundPrice(tp3),

    reason,

    timeframes: {

      H1: {

        bias:
          h1Structure.bias,

        reason:
          h1Structure.reason

      },

      M30: {

        bias:
          m30Structure.bias,

        zone:
          m30Range.zone,

        equilibrium:
          roundPrice(
            m30Range.equilibrium
          )

      },

      M15: {

        sellSideSweep:
          m15Sweep
            .sellSideSweep,

        buySideSweep:
          m15Sweep
            .buySideSweep,

        bullishMSS:
          m15MSS
            .bullishMSS,

        bearishMSS:
          m15MSS
            .bearishMSS,

        bullishFVG:
          !!m15BullishFVG,

        bearishFVG:
          !!m15BearishFVG,

        bullishDisplacement:
          m15Displacement
            .bullishDisplacement,

        bearishDisplacement:
          m15Displacement
            .bearishDisplacement

      },

      M5: {

        buyConfirmation:
          m5Buy.confirmed,

        sellConfirmation:
          m5Sell.confirmed,

        bullishFVG:
          m5Buy.fvg
            ? {

                low:
                  roundPrice(
                    m5Buy.fvg.low
                  ),

                high:
                  roundPrice(
                    m5Buy.fvg.high
                  )

              }
            : null,

        bearishFVG:
          m5Sell.fvg
            ? {

                low:
                  roundPrice(
                    m5Sell.fvg.low
                  ),

                high:
                  roundPrice(
                    m5Sell.fvg.high
                  )

              }
            : null

      }

    }

  };

}

/* ==============================
   PUSH NOTIFICATIONS
================================ */

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
      body

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

  subscriptions =
    active;

}

/* ==============================
   BACKGROUND SCAN
================================ */

async function backgroundScan() {

  if (state.scanning) {
    return;
  }

  state.scanning =
    true;

  state.lastError =
    null;

  try {

    /*
      MULTI-TIMEFRAME ICT DATA
    */

    const [
      h1,
      m30,
      m15,
      m5
    ] =
      await Promise.all([

        fetchCandles(
          "1h",
          120
        ),

        fetchCandles(
          "30min",
          120
        ),

        fetchCandles(
          "15min",
          120
        ),

        fetchCandles(
          "5min",
          150
        )

      ]);

    const latest =
      m5[
        m5.length - 1
      ];

    state.market = {

      symbol:
        "XAU/USD",

      price:
        roundPrice(
          latest.close
        ),

      updatedAt:
        new Date()
          .toISOString()

    };

    const result =
      analyzeICT(
        h1,
        m30,
        m15,
        m5
      );

    state.timeframes =
      result.timeframes;

    const previousSignal =
      state.signal.type;

    state.signal = {

      type:
        result.type,

      confidence:
        result.confidence,

      entry:
        result.entry,

      sl:
        result.sl,

      tp1:
        result.tp1,

      tp2:
        result.tp2,

      tp3:
        result.tp3,

      reason:
        result.reason,

      updatedAt:
        new Date()
          .toISOString()

    };

    /*
      Save only new BUY / SELL
      Sharp Entries.
    */

    if (
      result.type ===
        "BUY" ||
      result.type ===
        "SELL"
    ) {

      if (
        previousSignal !==
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

          sl:
            result.sl,

          tp1:
            result.tp1,

          tp2:
            result.tp2,

          tp3:
            result.tp3,

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

          `🔥 ICT SHARP ENTRY ${result.type}`,

          `XAU/USD ${result.type}
Entry ${result.entry}
SL ${result.sl}
TP1 ${result.tp1}
TP2 ${result.tp2}
TP3 ${result.tp3}
Confidence ${result.confidence}%`

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

    state.scanning =
      false;

  }

}

/* ==============================
   API ROUTES
================================ */

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

      success:
        true

    });

  }
);

app.post(
  "/api/test-notification",
  async (req, res) => {

    try {

      await sendPushToAll(

        "🔥 ICT Sharp Entry V3",

        "Notifications are working."

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

/* ==============================
   AUTO SCANNER
================================ */

setInterval(

  backgroundScan,

  SCAN_INTERVAL_MINUTES *
    60 *
    1000

);

backgroundScan();

/* ==============================
   START SERVER
================================ */

app.listen(
  PORT,
  () => {

    console.log(
      `ICT Sharp Entry V3 running on port ${PORT}`
    );

  }
);
