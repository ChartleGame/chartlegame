"use strict";

const fs   = require("fs");
const path = require("path");

const DATA_DIR     = path.join(__dirname, "data");
const DAILY_DIR    = path.join(DATA_DIR, "daily");
const PRACTICE_DIR = path.join(DATA_DIR, "practice");

[DATA_DIR, DAILY_DIR, PRACTICE_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const AV_KEY = process.env.ALPHA_VANTAGE_KEY;
const AV_BASE = "https://www.alphavantage.co/query";

// ── Asset universe ─────────────────────────────────────────────────────────────
// Stocks — top 100 most recognisable across tech, finance, consumer, health, energy, industrial
const STOCKS = [
  // Mega-cap tech
  "AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","AVGO","ORCL","AMD",
  "INTC","QCOM","TXN","MU","AMAT","ADBE","CRM","NOW","SNOW","PANW",
  // Finance
  "JPM","BAC","WFC","GS","MS","BLK","V","MA","PYPL","AXP",
  "C","USB","PNC","COF","SCHW","ICE","CME","BX","KKR","SPGI",
  // Consumer / Retail
  "WMT","COST","HD","TGT","LOW","MCD","SBUX","NKE","DIS","NFLX",
  "ABNB","UBER","LYFT","ETSY","EBAY","BABA","PDD","JD","SHOP","SQ",
  // Healthcare / Pharma
  "LLY","JNJ","UNH","PFE","MRK","ABBV","BMY","AMGN","GILD","BIIB",
  "CVS","CI","HUM","ISRG","BSX","MDT","SYK","ZTS","VRTX","REGN",
  // Energy
  "XOM","CVX","COP","SLB","EOG","PXD","MPC","VLO","PSX","OXY",
  // Industrial / Other
  "CAT","DE","BA","RTX","LMT","HON","GE","MMM","UPS","FDX",
  "TSLA","F","GM","TM","RIVN",
  // ETFs
  "SPY","QQQ","IWM","DIA","XLK","XLF","XLE","GLD","TLT","VXX",
];

// Crypto (Alpha Vantage uses FROM_CURRENCY / TO_CURRENCY)
const CRYPTO = [
  { from: "BTC", to: "USD", label: "BTC/USD" },
  { from: "ETH", to: "USD", label: "ETH/USD" },
  { from: "SOL", to: "USD", label: "SOL/USD" },
  { from: "BNB", to: "USD", label: "BNB/USD" },
  { from: "XRP", to: "USD", label: "XRP/USD" },
  { from: "ADA", to: "USD", label: "ADA/USD" },
  { from: "DOGE", to: "USD", label: "DOGE/USD" },
  { from: "AVAX", to: "USD", label: "AVAX/USD" },
];

// Forex
const FOREX = [
  { from: "EUR", to: "USD", label: "EUR/USD" },
  { from: "GBP", to: "USD", label: "GBP/USD" },
  { from: "USD", to: "JPY", label: "USD/JPY" },
  { from: "USD", to: "CAD", label: "USD/CAD" },
  { from: "AUD", to: "USD", label: "AUD/USD" },
  { from: "USD", to: "CHF", label: "USD/CHF" },
];

// Timeframes — Alpha Vantage interval strings
// 15min, 60min, and daily (used as "4H equivalent" with 4-bar grouping)
const TIMEFRAMES = ["daily"];
const TF_LABELS  = { "15min": "15M", "60min": "1H", "daily": "1D" };

// ── Alpha Vantage fetch helpers ───────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch stock OHLCV from Alpha Vantage
// Returns array of { open, high, low, close, volume } newest-first
async function fetchStock(symbol, interval) {
  const isIntraday = interval !== "daily";
  const fn = isIntraday ? "TIME_SERIES_INTRADAY" : "TIME_SERIES_DAILY";

  const params = new URLSearchParams({
    function:   fn,
    symbol,
    apikey:     AV_KEY,
    outputsize: "compact", // last 100 data points
    ...(isIntraday ? { interval } : {}),
  });

  const url = `${AV_BASE}?${params}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const json = await res.json();

  // Detect rate limit / error messages
  if (json["Note"] || json["Information"]) {
    throw new Error(`API limit hit: ${json["Note"] || json["Information"]}`);
  }

  // Parse time series
  const seriesKey = Object.keys(json).find(k => k.startsWith("Time Series"));
  if (!seriesKey) throw new Error(`No time series in response for ${symbol}: ${JSON.stringify(json).slice(0, 120)}`);

  const series = json[seriesKey];
  const bars = Object.entries(series)
    .sort(([a], [b]) => a < b ? -1 : 1) // oldest first
    .map(([, v]) => ({
      open:   parseFloat(v["1. open"]),
      high:   parseFloat(v["2. high"]),
      low:    parseFloat(v["3. low"]),
      close:  parseFloat(v["4. close"]),
      volume: parseFloat(v["5. volume"]),
    }));

  return bars;
}

// Fetch crypto OHLCV
async function fetchCrypto(fromSymbol, toSymbol, interval) {
  const isIntraday = interval !== "daily";
  const fn = isIntraday ? "CRYPTO_INTRADAY" : "DIGITAL_CURRENCY_DAILY";

  const params = new URLSearchParams({
    function:     fn,
    symbol:       fromSymbol,
    market:       toSymbol,
    apikey:       AV_KEY,
    outputsize:   "compact",
    ...(isIntraday ? { interval } : {}),
  });

  const url = `${AV_BASE}?${params}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();

  if (json["Note"] || json["Information"]) {
    throw new Error(`API limit hit: ${json["Note"] || json["Information"]}`);
  }

  const seriesKey = Object.keys(json).find(k => k.startsWith("Time Series"));
  if (!seriesKey) throw new Error(`No time series for ${fromSymbol}/${toSymbol}`);

  const series = json[seriesKey];
  const bars = Object.entries(series)
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([, v]) => ({
      open:   parseFloat(v["1. open"] || v["1a. open (USD)"]),
      high:   parseFloat(v["2. high"] || v["2a. high (USD)"]),
      low:    parseFloat(v["3. low"]  || v["3a. low (USD)"]),
      close:  parseFloat(v["4. close"]|| v["4a. close (USD)"]),
      volume: parseFloat(v["5. volume"] || v["5. volume"] || 0),
    }));

  return bars;
}

// Fetch forex OHLCV
async function fetchForex(fromSymbol, toSymbol, interval) {
  const isIntraday = interval !== "daily";
  const fn = isIntraday ? "FX_INTRADAY" : "FX_DAILY";

  const params = new URLSearchParams({
    function:       fn,
    from_symbol:    fromSymbol,
    to_symbol:      toSymbol,
    apikey:         AV_KEY,
    outputsize:     "compact",
    ...(isIntraday ? { interval } : {}),
  });

  const url = `${AV_BASE}?${params}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();

  if (json["Note"] || json["Information"]) {
    throw new Error(`API limit hit: ${json["Note"] || json["Information"]}`);
  }

  const seriesKey = Object.keys(json).find(k => k.startsWith("Time Series"));
  if (!seriesKey) throw new Error(`No time series for ${fromSymbol}/${toSymbol}`);

  const series = json[seriesKey];
  const bars = Object.entries(series)
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([, v]) => ({
      open:   parseFloat(v["1. open"]),
      high:   parseFloat(v["2. high"]),
      low:    parseFloat(v["3. low"]),
      close:  parseFloat(v["4. close"]),
      volume: 0,
    }));

  return bars;
}

// ── Chart builder ─────────────────────────────────────────────────────────────
// Takes raw bars (oldest first), picks last 100, uses 80 for display
// Generates 20 synthetic future candles from the last close
function buildChart(bars, asset, tf, assetType) {
  if (bars.length < 30) throw new Error(`Not enough bars for ${asset}: got ${bars.length}`);

  // Keep last 100 bars (80 display + 20 warmup for MAs)
  const trimmed  = bars.slice(-100);
  const last     = trimmed[trimmed.length - 1];
  const entryPrice = last.close;

  // Generate 20 synthetic future candles seeded from last close
  // Using a simple random walk based on recent volatility
  const recentBars = trimmed.slice(-20);
  const avgRange   = recentBars.reduce((s, b) => s + (b.high - b.low), 0) / recentBars.length;
  const volatility = avgRange / entryPrice; // as fraction

  const future = [];
  let price = entryPrice;
  for (let i = 0; i < 20; i++) {
    const drift = (Math.random() - 0.48) * volatility * price;
    const range = (0.5 + Math.random() * 0.8) * avgRange;
    const open  = price;
    const close = price + drift;
    const high  = Math.max(open, close) + Math.random() * range * 0.5;
    const low   = Math.min(open, close) - Math.random() * range * 0.5;
    const vol   = last.volume * (0.6 + Math.random() * 0.8);
    future.push({ open, high, low, close, volume: vol });
    price = close; 
  }

  return {
    asset,
    tf: TF_LABELS[tf] || tf,
    assetType,          // "stock" | "crypto" | "forex"
    entryPrice,
    displayBars: 80,
    candles:  trimmed,
    future,
    fetchedAt: Date.now(),
  };
}

// ── Random asset picker ───────────────────────────────────────────────────────
// Weighted: 70% stocks, 15% crypto, 15% forex
function randomAsset() {
  const roll = Math.random();
  if (roll < 0.70) {
    const symbol = STOCKS[Math.floor(Math.random() * STOCKS.length)];
    const tf     = TIMEFRAMES[Math.floor(Math.random() * TIMEFRAMES.length)];
    return { type: "stock", symbol, tf };
  } else if (roll < 0.85) {
    const pair = CRYPTO[Math.floor(Math.random() * CRYPTO.length)];
    // Crypto intraday only available on premium AV — use daily for free tier
    return { type: "crypto", ...pair, tf: "daily" };
  } else {
    const pair = FOREX[Math.floor(Math.random() * FOREX.length)];
    return { type: "forex", ...pair, tf: "daily" };
  }
}

// ── Core fetch function ───────────────────────────────────────────────────────
async function fetchChart(asset) {
  let bars;
  if (asset.type === "stock") {
    bars = await fetchStock(asset.symbol, asset.tf);
    return buildChart(bars, asset.symbol, asset.tf, "stock");
  } else if (asset.type === "crypto") {
    bars = await fetchCrypto(asset.from, asset.to, asset.tf);
    return buildChart(bars, asset.label, asset.tf, "crypto");
  } else {
    bars = await fetchForex(asset.from, asset.to, asset.tf);
    return buildChart(bars, asset.label, asset.tf, "forex");
  }
}

// ── Exported functions ────────────────────────────────────────────────────────

// Called by cron at midnight — fetch today's daily chart
async function fetchAndSaveDailyChart() {
  const d   = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const out = path.join(DAILY_DIR, `${key}.json`);

  if (fs.existsSync(out)) {
    console.log(`[DAILY] ${key}.json already exists, skipping.`);
    return;
  }

  const asset = randomAsset();
  console.log(`[DAILY] Fetching ${asset.type}: ${asset.symbol || asset.label} @ ${asset.tf}`);

  const chart = await fetchChart(asset);
  chart.isDaily = true;
  chart.date    = key;

  fs.writeFileSync(out, JSON.stringify(chart), "utf8");
  console.log(`[DAILY] Saved ${out}`);
}

// Called by cron hourly — add one practice chart to the pool
async function fetchAndSavePracticeChart() {
  const files    = fs.readdirSync(PRACTICE_DIR).filter(f => f.endsWith(".json"));
  const nextId   = String(files.length + 1).padStart(4, "0");
  const out      = path.join(PRACTICE_DIR, `${nextId}.json`);

  const asset = randomAsset();
  console.log(`[PRACTICE] Fetching ${asset.type}: ${asset.symbol || asset.label} @ ${asset.tf} → ${nextId}.json`);

  const chart = await fetchChart(asset);
  chart.practiceId = nextId;

  fs.writeFileSync(out, JSON.stringify(chart), "utf8");
  console.log(`[PRACTICE] Saved ${out} (pool: ${files.length + 1})`);
}

module.exports = { fetchAndSaveDailyChart, fetchAndSavePracticeChart };

// ── Standalone execution ──────────────────────────────────────────────────────
// Run directly with: node server/cron.js [daily|practice|both]
if (require.main === module) {
  const mode = process.argv[2] || "both";
  (async () => {
    if (!AV_KEY || AV_KEY === "YOUR_ALPHA_VANTAGE_KEY") {
      console.error("❌ Set ALPHA_VANTAGE_KEY in your .env file first.");
      process.exit(1);
    }
    if (mode === "daily" || mode === "both") {
      await fetchAndSaveDailyChart();
      if (mode === "both") await sleep(15000); // respect rate limit
    }
    if (mode === "practice" || mode === "both") {
      await fetchAndSavePracticeChart();
    }
    console.log("Done.");
  })();
}
