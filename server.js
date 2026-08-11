require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SCAN_INTERVAL_MINUTES = Math.max(1, Number(process.env.SCAN_INTERVAL_MINUTES || 5));
const HISTORY_FILE = path.join(__dirname, 'signal-history.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let state = {
  running: true,
  scanning: false,
  lastScanAt: null,
  lastError: null,
  lastSignal: null,
  nextScanAt: null,
  market: { symbol: 'XAU/USD', price: null, updatedAt: null },
  history: loadHistory()
};

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(state.history.slice(0, 100), null, 2));
  } catch (err) {
    console.error('Could not save history:', err.message);
  }
}

function sma(values, period) {
  if (values.length < period) return null;
  const s = values.slice(-period).reduce((a, b) => a + b, 0);
  return s / period;
}

function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let prev = values[0];
  return values.map((v, i) => {
    if (i === 0) return prev;
    prev = v * k + prev * (1 - k);
    return prev;
  });
}

function ema(values, period) {
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : null;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return sma(trs, period);
}

function normalize(values) {
  return values
    .map(v => ({
      datetime: v.datetime,
      open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close)
    }))
    .filter(v => [v.open, v.high, v.low, v.close].every(Number.isFinite))
    .reverse(); // Twelve Data normally returns newest first; analyzer wants oldest first.
}

async function fetchCandles(interval, outputsize = 120) {
  if (!API_KEY) throw new Error('TWELVE_DATA_API_KEY is not set.');
  const params = new URLSearchParams({
    symbol: 'XAU/USD', interval, outputsize: String(outputsize), apikey: API_KEY, format: 'JSON'
  });
  const url = `https://api.twelvedata.com/time_series?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Market API HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === 'error') throw new Error(data.message || 'Market API error');
  if (!Array.isArray(data.values) || data.values.length < 30) throw new Error('Not enough market data returned.');
  return normalize(data.values);
}

function detectFVG(candles) {
  if (candles.length < 4) return { bullish: false, bearish: false };
  const a = candles[candles.length - 3];
  const c = candles[candles.length - 1];
  return {
    bullish: c.low > a.high,
    bearish: c.high < a.low
  };
}

function analyze(h1, m15, m5) {
  const h1Close = h1.map(c => c.close);
  const m15Close = m15.map(c => c.close);
  const m5Close = m5.map(c => c.close);

  const price = m5Close[m5Close.length - 1];
  const h1e20 = ema(h1Close, 20), h1e50 = ema(h1Close, 50);
  const m15e20 = ema(m15Close, 20), m15e50 = ema(m15Close, 50);
  const m5e9 = ema(m5Close, 9), m5e20 = ema(m5Close, 20);
  const m5rsi = rsi(m5Close, 14);
  const m5atr = atr(m5, 14) || Math.max(price * 0.001, 1);

  const trend = h1e20 > h1e50 ? 'BULLISH' : h1e20 < h1e50 ? 'BEARISH' : 'NEUTRAL';
  const structure = m15e20 > m15e50 ? 'BULLISH' : m15e20 < m15e50 ? 'BEARISH' : 'NEUTRAL';

  const previous = m5.slice(-12, -1);
  const recentHigh = Math.max(...previous.map(c => c.high));
  const recentLow = Math.min(...previous.map(c => c.low));
  const last = m5[m5.length - 1];
  const prev = m5[m5.length - 2];

  const bosUp = last.close > recentHigh;
  const bosDown = last.close < recentLow;
  const sweepLow = last.low < recentLow && last.close > recentLow;
  const sweepHigh = last.high > recentHigh && last.close < recentHigh;
  const momentumUp = last.close > last.open && last.close > prev.close && m5e9 > m5e20;
  const momentumDown = last.close < last.open && last.close < prev.close && m5e9 < m5e20;
  const fvg = detectFVG(m5);

  let buyScore = 0, sellScore = 0;
  const buyReasons = [], sellReasons = [];

  if (trend === 'BULLISH') { buyScore += 25; buyReasons.push('H1 bullish trend'); }
  if (trend === 'BEARISH') { sellScore += 25; sellReasons.push('H1 bearish trend'); }
  if (structure === 'BULLISH') { buyScore += 20; buyReasons.push('M15 bullish structure'); }
  if (structure === 'BEARISH') { sellScore += 20; sellReasons.push('M15 bearish structure'); }
  if (bosUp) { buyScore += 20; buyReasons.push('M5 break of structure'); }
  if (bosDown) { sellScore += 20; sellReasons.push('M5 break of structure'); }
  if (sweepLow) { buyScore += 15; buyReasons.push('Liquidity sweep below'); }
  if (sweepHigh) { sellScore += 15; sellReasons.push('Liquidity sweep above'); }
  if (fvg.bullish) { buyScore += 10; buyReasons.push('Bullish FVG'); }
  if (fvg.bearish) { sellScore += 10; sellReasons.push('Bearish FVG'); }
  if (momentumUp) { buyScore += 10; buyReasons.push('M5 bullish momentum'); }
  if (momentumDown) { sellScore += 10; sellReasons.push('M5 bearish momentum'); }
  if (m5rsi != null && m5rsi >= 50 && m5rsi <= 72) { buyScore += 10; buyReasons.push('RSI supports buy'); }
  if (m5rsi != null && m5rsi >= 28 && m5rsi <= 50) { sellScore += 10; sellReasons.push('RSI supports sell'); }

  buyScore = Math.min(100, buyScore);
  sellScore = Math.min(100, sellScore);

  let signal = 'WAIT', confidence = Math.max(buyScore, sellScore), reasons = [];
  if (buyScore >= 70 && buyScore >= sellScore + 15 && trend !== 'BEARISH') {
    signal = 'BUY'; confidence = buyScore; reasons = buyReasons;
  } else if (sellScore >= 70 && sellScore >= buyScore + 15 && trend !== 'BULLISH') {
    signal = 'SELL'; confidence = sellScore; reasons = sellReasons;
  } else {
    reasons = buyScore >= sellScore ? buyReasons : sellReasons;
  }

  const slDistance = Math.max(m5atr * 1.5, price * 0.0012);
  const entry = price;
  const sl = signal === 'BUY' ? entry - slDistance : signal === 'SELL' ? entry + slDistance : null;
  const risk = sl == null ? null : Math.abs(entry - sl);
  const tp1 = signal === 'BUY' ? entry + risk : signal === 'SELL' ? entry - risk : null;
  const tp2 = signal === 'BUY' ? entry + risk * 2 : signal === 'SELL' ? entry - risk * 2 : null;
  const tp3 = signal === 'BUY' ? entry + risk * 3 : signal === 'SELL' ? entry - risk * 3 : null;

  return {
    id: `${last.datetime}-${signal}`,
    symbol: 'XAU/USD',
    signal,
    confidence,
    scores: { buy: buyScore, sell: sellScore },
    trend,
    structure,
    entry,
    sl, tp1, tp2, tp3,
    rsi: m5rsi,
    atr: m5atr,
    reasons: reasons.slice(0, 6),
    candleTime: last.datetime,
    scannedAt: new Date().toISOString(),
    chart: m5.slice(-50).map(c => ({ time: c.datetime, close: c.close }))
  };
}

async function sendTelegram(signal, force = false) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, skipped: true, reason: 'Telegram is not configured' };
  if (!force && signal.signal === 'WAIT') return { ok: false, skipped: true, reason: 'WAIT signals are not sent' };

  const n = x => Number.isFinite(x) ? x.toFixed(2) : '-';
  const text = signal.signal === 'WAIT'
    ? `🟡 SHARP ENTRY V3 TEST\nTelegram is connected.\nGold scanner is online.`
    : `${signal.signal === 'BUY' ? '🟢' : '🔴'} SHARP ENTRY V3 — ${signal.signal}\n\n` +
      `Gold: XAU/USD\nConfidence: ${signal.confidence}%\nEntry: ${n(signal.entry)}\nStop Loss: ${n(signal.sl)}\nTP1: ${n(signal.tp1)}\nTP2: ${n(signal.tp2)}\nTP3: ${n(signal.tp3)}\n\n` +
      `H1 Trend: ${signal.trend}\nM15 Structure: ${signal.structure}\nTime: ${signal.candleTime}\n\n` +
      `Reasons: ${signal.reasons.join(', ')}`;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Telegram send failed');
  return { ok: true };
}

async function scanMarket({ manual = false } = {}) {
  if (state.scanning) return state.lastSignal;
  state.scanning = true;
  state.lastError = null;
  try {
    const [h1, m15, m5] = await Promise.all([
      fetchCandles('1h', 100),
      fetchCandles('15min', 120),
      fetchCandles('5min', 150)
    ]);
    const result = analyze(h1, m15, m5);
    state.market.price = result.entry;
    state.market.updatedAt = result.scannedAt;
    state.lastScanAt = result.scannedAt;

    const previousSignal = state.history.find(x => x.signal !== 'WAIT');
    const isNewActionable = result.signal !== 'WAIT' && (!previousSignal || previousSignal.id !== result.id);

    state.lastSignal = result;
    if (manual || isNewActionable) {
      state.history.unshift(result);
      state.history = state.history.slice(0, 100);
      saveHistory();
    }
    if (isNewActionable) {
      await sendTelegram(result).catch(err => console.error('Telegram:', err.message));
    }
    return result;
  } catch (err) {
    state.lastError = err.message;
    throw err;
  } finally {
    state.scanning = false;
    state.nextScanAt = new Date(Date.now() + SCAN_INTERVAL_MINUTES * 60000).toISOString();
  }
}

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    running: state.running,
    scanning: state.scanning,
    lastScanAt: state.lastScanAt,
    nextScanAt: state.nextScanAt,
    lastError: state.lastError,
    market: state.market,
    signal: state.lastSignal,
    historyCount: state.history.length,
    config: {
      intervalMinutes: SCAN_INTERVAL_MINUTES,
      marketApiConfigured: Boolean(API_KEY),
      telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
    }
  });
});

app.get('/api/history', (req, res) => res.json({ history: state.history.slice(0, 50) }));

app.post('/api/scan', async (req, res) => {
  try {
    const result = await scanMarket({ manual: true });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/telegram/test', async (req, res) => {
  try {
    const sample = state.lastSignal || { signal: 'WAIT' };
    const result = await sendTelegram(sample, true);
    if (result.skipped) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'sharp-entry-v3', time: new Date().toISOString() }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Sharp Entry V3 running on port ${PORT}`);
  state.nextScanAt = new Date(Date.now() + 5000).toISOString();
  setTimeout(() => scanMarket().catch(err => console.error('Initial scan:', err.message)), 5000);
  setInterval(() => {
    if (state.running) scanMarket().catch(err => console.error('Auto scan:', err.message));
  }, SCAN_INTERVAL_MINUTES * 60000);
});
