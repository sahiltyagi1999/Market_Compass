import { fetchJson, toNumber } from './http.js';
import { istDateKey } from './marketSession.js';
import type { Candle, MarketCard } from './types.js';
import { closedCandles, fetchHistoricalCandles, fetchIntradayCandles, upstoxToken } from './upstox.js';

export interface PricePoint {
  price: number;
  /** Close time of the candle the price came from (epoch ms). */
  at: number;
}

export type PriceLookup = (market: MarketCard['slug'], time: number) => Promise<PricePoint | null>;

/**
 * Close of the last candle that finished at or before `time`, provided it
 * finished no more than `toleranceMs` earlier. Returns null rather than a
 * stale price when data around `time` is missing.
 */
export function closeAtOrBefore(candles: Candle[], intervalMs: number, time: number, toleranceMs: number): PricePoint | null {
  let best: PricePoint | null = null;
  for (const candle of candles) {
    const closeAt = candle.time + intervalMs;
    if (closeAt > time) continue;
    if (!best || closeAt > best.at) best = { price: candle.close, at: closeAt };
  }
  if (!best || time - best.at > toleranceMs) return null;
  return best;
}

const MINUTE = 60_000;

async function cryptoPriceAt(time: number): Promise<PricePoint | null> {
  const rows = await fetchJson<unknown[][]>(
    `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&endTime=${Math.floor(time)}&limit=5`
  );
  const candles: Candle[] = rows.map((row) => ({
    time: Number(row[0]),
    open: toNumber(row[1]) ?? Number.NaN,
    high: toNumber(row[2]) ?? Number.NaN,
    low: toNumber(row[3]) ?? Number.NaN,
    close: toNumber(row[4]) ?? Number.NaN,
    volume: toNumber(row[5]) ?? 0
  })).filter((candle) => Number.isFinite(candle.close));
  return closeAtOrBefore(closedCandles(candles, MINUTE, Date.now()), MINUTE, time, 3 * MINUTE);
}

async function niftyPriceAt(time: number): Promise<PricePoint | null> {
  const token = upstoxToken();
  if (!token) return null;
  const key = process.env.UPSTOX_NIFTY_KEY || 'NSE_INDEX|Nifty 50';
  const date = istDateKey(time);
  const candles = date === istDateKey(Date.now())
    ? await fetchIntradayCandles(token, key, 5)
    : await fetchHistoricalCandles(token, key, date, date, 5);
  // Only candles from the same IST session date; never borrow the next day's price.
  const sameDay = closedCandles(candles, 5 * MINUTE, Date.now()).filter((candle) => istDateKey(candle.time) === date);
  return closeAtOrBefore(sameDay, 5 * MINUTE, time, 10 * MINUTE);
}

export const livePriceLookup: PriceLookup = (market, time) => market === 'crypto' ? cryptoPriceAt(time) : niftyPriceAt(time);
