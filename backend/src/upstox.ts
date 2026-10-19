import { fetchJson, fetchJsonMeta, toNumber } from './http.js';
import type { Candle } from './types.js';

const BASE = 'https://api.upstox.com';

export function upstoxToken() {
  return process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || '';
}

export function upstoxHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

/** Upstox candle rows: [ISO start time, open, high, low, close, volume, oi]. */
export function parseCandle(row: unknown[]): Candle | null {
  const timeValue = typeof row[0] === 'number' ? row[0] : new Date(String(row[0])).getTime();
  const values = row.slice(1, 6).map(toNumber);
  if (!Number.isFinite(timeValue) || values.slice(0, 4).some((value) => value == null)) return null;
  return {
    time: timeValue,
    open: values[0]!,
    high: values[1]!,
    low: values[2]!,
    close: values[3]!,
    volume: values[4] ?? 0
  };
}

/**
 * Drops candles that have not closed yet. Upstox does not document whether
 * the forming candle is included, so this is enforced on our side.
 */
export function closedCandles(candles: Candle[], intervalMs: number, now: number) {
  return candles.filter((candle) => candle.time + intervalMs <= now);
}

export async function fetchIntradayCandles(token: string, instrumentKey: string, minutes = 5) {
  const body = await fetchJson<{ data?: { candles?: unknown[][] } }>(
    `${BASE}/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/${minutes}`,
    { headers: upstoxHeaders(token) },
    30_000
  );
  return (body.data?.candles || []).map(parseCandle).filter((item): item is Candle => Boolean(item)).sort((a, b) => a.time - b.time);
}

/** Historical minute candles for an inclusive IST date range (max 1 month per call for <=15m). */
export async function fetchHistoricalCandles(token: string, instrumentKey: string, fromDate: string, toDate: string, minutes = 5) {
  const body = await fetchJson<{ data?: { candles?: unknown[][] } }>(
    `${BASE}/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/${minutes}/${toDate}/${fromDate}`,
    { headers: upstoxHeaders(token) },
    10 * 60 * 1000
  );
  return (body.data?.candles || []).map(parseCandle).filter((item): item is Candle => Boolean(item)).sort((a, b) => a.time - b.time);
}

type LtpPayload = { data?: Record<string, { last_price?: number; cp?: number; instrument_token?: string; volume?: number }> };

/** LTP v3 for up to 500 keys. Response keys use ':' instead of '|', so map back via instrument_token. */
export async function fetchLtp(token: string, instrumentKeys: string[]) {
  const fetched = await fetchJsonMeta<LtpPayload>(
    `${BASE}/v3/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKeys.join(','))}`,
    { headers: upstoxHeaders(token) },
    0
  );
  const byKey = new Map<string, { price?: number; previousClose?: number }>();
  for (const [responseKey, quote] of Object.entries(fetched.value.data || {})) {
    const key = quote.instrument_token || responseKey.replace(':', '|');
    byKey.set(key, { price: toNumber(quote.last_price), previousClose: toNumber(quote.cp) });
  }
  return { quotes: byKey, retrievedAt: fetched.retrievedAt };
}

export interface FullQuote {
  instrumentKey: string;
  symbol?: string;
  lastPrice?: number;
  previousClose?: number;
  averagePrice?: number;
  volume?: number;
  lastTradeTime?: number;
}

type FullQuotePayload = {
  data?: Record<string, {
    instrument_token?: string;
    symbol?: string;
    last_price?: number;
    prev_close_price?: number;
    average_price?: number;
    volume?: number;
    last_trade_time?: string | number;
    net_change?: number;
  }>;
};

/** Full quote v3 (adds prev_close_price) for up to 500 keys. */
export async function fetchFullQuotes(token: string, instrumentKeys: string[]) {
  const fetched = await fetchJsonMeta<FullQuotePayload>(
    `${BASE}/v3/market-quote/quotes?instrument_key=${encodeURIComponent(instrumentKeys.join(','))}`,
    { headers: upstoxHeaders(token) },
    0
  );
  const quotes: FullQuote[] = Object.entries(fetched.value.data || {}).map(([responseKey, quote]) => {
    const lastPrice = toNumber(quote.last_price);
    const netChange = toNumber(quote.net_change);
    return {
      instrumentKey: quote.instrument_token || responseKey.replace(':', '|'),
      symbol: quote.symbol,
      lastPrice,
      previousClose: toNumber(quote.prev_close_price) ?? (lastPrice != null && netChange != null ? lastPrice - netChange : undefined),
      averagePrice: toNumber(quote.average_price),
      volume: toNumber(quote.volume),
      lastTradeTime: toNumber(quote.last_trade_time)
    };
  });
  return { quotes, retrievedAt: fetched.retrievedAt };
}
