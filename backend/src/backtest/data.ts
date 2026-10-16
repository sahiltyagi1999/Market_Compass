import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchJson, toNumber } from '../http.js';
import { istDateKey } from '../marketSession.js';
import type { Candle } from '../types.js';
import { fetchHistoricalCandles, upstoxToken } from '../upstox.js';
import { HOUR, type CryptoHistory, type NiftyHistory } from './replay.js';

export const HISTORY_DIR = fileURLToPath(new URL('../../data/history/', import.meta.url));

async function readCache<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(`${HISTORY_DIR}${name}`, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeCache(name: string, value: unknown) {
  await mkdir(HISTORY_DIR, { recursive: true });
  await writeFile(`${HISTORY_DIR}${name}`, JSON.stringify(value), 'utf8');
}

/** Paginates Binance spot klines (max 1000 per request) from `start` to `end`; candle time = open time. */
export async function fetchBinanceKlines(symbol: string, intervalMs: number, start: number, end: number): Promise<Candle[]> {
  const interval = intervalMs === HOUR ? '1h' : intervalMs === 60_000 ? '1m' : null;
  if (!interval) throw new Error('Unsupported Binance interval.');
  const cacheName = `binance-${symbol}-${interval}.json`;
  const cached = (await readCache<Candle[]>(cacheName)) ?? [];
  const have = new Map(cached.map((candle) => [candle.time, candle]));
  let cursor = cached.length ? Math.max(start, cached[cached.length - 1].time + intervalMs) : start;
  if (cached.length && cached[0].time > start) cursor = start;
  while (cursor < end) {
    const rows = await fetchJson<unknown[][]>(
      `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1000`,
      undefined,
      0,
      20_000
    );
    if (!rows.length) break;
    for (const row of rows) {
      const candle: Candle = {
        time: Number(row[0]),
        open: toNumber(row[1]) ?? Number.NaN,
        high: toNumber(row[2]) ?? Number.NaN,
        low: toNumber(row[3]) ?? Number.NaN,
        close: toNumber(row[4]) ?? Number.NaN,
        volume: toNumber(row[5]) ?? 0
      };
      // Only fully closed candles are stored.
      if (Number(row[6]) < Date.now()) have.set(candle.time, candle);
    }
    const last = Number(rows[rows.length - 1][0]);
    if (last + intervalMs <= cursor) break;
    cursor = last + intervalMs;
  }
  const all = [...have.values()].sort((left, right) => left.time - right.time);
  await writeCache(cacheName, all);
  return all.filter((candle) => candle.time >= start && candle.time < end);
}

export async function fetchFearGreedHistory(): Promise<CryptoHistory['fearGreed']> {
  const body = await fetchJson<{ data?: Array<{ value?: string; value_classification?: string; timestamp?: string }> }>(
    'https://api.alternative.me/fng/?limit=0&format=json',
    undefined,
    0,
    30_000
  );
  const series = (body.data || [])
    .map((row) => ({ time: (toNumber(row.timestamp) ?? 0) * 1000, value: toNumber(row.value) ?? Number.NaN, label: row.value_classification }))
    .filter((row) => row.time > 0 && Number.isFinite(row.value))
    .sort((left, right) => left.time - right.time);
  await writeCache('alternative-me-fng.json', series);
  return series;
}

export const CRYPTO_BASKET = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT', 'DOGEUSDT', 'ADAUSDT', 'TRXUSDT', 'AVAXUSDT', 'LINKUSDT'];

export async function loadCryptoHistory(start: number, end: number): Promise<CryptoHistory> {
  const basket: Record<string, Candle[]> = {};
  for (const symbol of CRYPTO_BASKET) basket[symbol] = await fetchBinanceKlines(symbol, HOUR, start, end);
  return {
    intervalMs: HOUR,
    btc: basket.BTCUSDT,
    eth: basket.ETHUSDT,
    basket,
    fearGreed: await fetchFearGreedHistory()
  };
}

function monthChunks(start: number, end: number) {
  const chunks: Array<{ from: string; to: string }> = [];
  let cursor = new Date(start);
  while (cursor.getTime() < end) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    chunks.push({ from: istDateKey(cursor.getTime()), to: istDateKey(Math.min(next.getTime(), end) - 1) });
    cursor = next;
  }
  return chunks;
}

/** Upstox 5m history (1 month per request for minute candles). Requires UPSTOX_ANALYTICS_TOKEN. */
export async function fetchUpstoxHistory(instrumentKey: string, start: number, end: number): Promise<Candle[]> {
  const token = upstoxToken();
  if (!token) throw new Error('UPSTOX_ANALYTICS_TOKEN is required for NIFTY history.');
  const cacheName = `upstox-${instrumentKey.replace(/[^A-Za-z0-9]+/g, '_')}-5m.json`;
  const cached = (await readCache<Candle[]>(cacheName)) ?? [];
  const have = new Map(cached.map((candle) => [candle.time, candle]));
  const cachedDays = new Set(cached.map((candle) => istDateKey(candle.time)));
  for (const chunk of monthChunks(start, end)) {
    // Skip months already fully cached (except the current one).
    if (cachedDays.has(chunk.from) && cachedDays.has(chunk.to) && chunk.to < istDateKey(Date.now())) continue;
    const candles = await fetchHistoricalCandles(token, instrumentKey, chunk.from, chunk.to, 5);
    for (const candle of candles) if (candle.time + 5 * 60_000 <= Date.now()) have.set(candle.time, candle);
  }
  const all = [...have.values()].sort((left, right) => left.time - right.time);
  await writeCache(cacheName, all);
  return all.filter((candle) => candle.time >= start && candle.time < end);
}

export async function loadNiftyHistory(start: number, end: number): Promise<NiftyHistory> {
  const niftyKey = process.env.UPSTOX_NIFTY_KEY || 'NSE_INDEX|Nifty 50';
  const vixKey = process.env.UPSTOX_VIX_KEY || 'NSE_INDEX|India VIX';
  return {
    intervalMs: 5 * 60_000,
    nifty: await fetchUpstoxHistory(niftyKey, start, end),
    vix: await fetchUpstoxHistory(vixKey, start, end)
  };
}
