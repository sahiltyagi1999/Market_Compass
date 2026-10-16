import { fetchJson, toNumber } from './http.js';
import type { CryptoDerivatives } from './types.js';

/** Percentile rank (0-100) of `value` within `history` (inclusive). */
export function percentileRank(value: number, history: number[]) {
  const valid = history.filter(Number.isFinite);
  if (!valid.length) return null;
  const below = valid.filter((item) => item < value).length;
  const equal = valid.filter((item) => item === value).length;
  return Number((((below + equal * 0.5) / valid.length) * 100).toFixed(1));
}

/** (bid depth - ask depth) / total within `bandPct` of the mid price; -1..1. */
export function orderBookImbalance(bids: Array<[string, string]>, asks: Array<[string, string]>, bandPct = 0.5) {
  const bestBid = toNumber(bids[0]?.[0]);
  const bestAsk = toNumber(asks[0]?.[0]);
  if (!bestBid || !bestAsk || bestAsk < bestBid) return null;
  const mid = (bestBid + bestAsk) / 2;
  const within = (levels: Array<[string, string]>) => levels.reduce((sum, [price, qty]) => {
    const p = toNumber(price);
    const q = toNumber(qty);
    return p != null && q != null && Math.abs(p - mid) / mid * 100 <= bandPct ? sum + p * q : sum;
  }, 0);
  const bidDepth = within(bids);
  const askDepth = within(asks);
  const total = bidDepth + askDepth;
  return total > 0 ? Number(((bidDepth - askDepth) / total).toFixed(3)) : null;
}

async function binanceDerivatives(): Promise<CryptoDerivatives> {
  const base = 'https://fapi.binance.com';
  const [premium, funding, oiHistory] = await Promise.all([
    fetchJson<{ markPrice?: string; indexPrice?: string; lastFundingRate?: string }>(`${base}/fapi/v1/premiumIndex?symbol=BTCUSDT`, undefined, 60_000, 6000),
    fetchJson<Array<{ fundingRate?: string }>>(`${base}/fapi/v1/fundingRate?symbol=BTCUSDT&limit=90`, undefined, 30 * 60_000, 6000),
    fetchJson<Array<{ sumOpenInterest?: string; timestamp?: number }>>(`${base}/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=25`, undefined, 5 * 60_000, 6000)
  ]);
  const mark = toNumber(premium.markPrice);
  const index = toNumber(premium.indexPrice);
  const rate = toNumber(premium.lastFundingRate);
  const history = funding.map((row) => toNumber(row.fundingRate)).filter((value): value is number => value != null);
  const oi = oiHistory.map((row) => toNumber(row.sumOpenInterest)).filter((value): value is number => value != null);
  return {
    source: 'Binance USD-M futures',
    fundingRatePct: rate == null ? null : rate * 100,
    fundingPercentile: rate == null ? null : percentileRank(rate, history),
    openInterest: oi.at(-1) ?? null,
    openInterestChangePct: oi.length >= 2 && oi[0] > 0 ? ((oi[oi.length - 1] - oi[0]) / oi[0]) * 100 : null,
    basisPct: mark && index ? ((mark - index) / index) * 100 : null,
    orderBookImbalance: null
  };
}

async function okxDerivatives(): Promise<CryptoDerivatives> {
  const base = 'https://www.okx.com/api/v5';
  type Envelope<T> = { code?: string; data?: T[] };
  const [current, history, oi] = await Promise.all([
    fetchJson<Envelope<{ fundingRate?: string; premium?: string }>>(`${base}/public/funding-rate?instId=BTC-USDT-SWAP`, undefined, 60_000, 6000),
    fetchJson<Envelope<{ fundingRate?: string; realizedRate?: string }>>(`${base}/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=90`, undefined, 30 * 60_000, 6000),
    fetchJson<Envelope<string[]>>(`${base}/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1H`, undefined, 5 * 60_000, 6000)
  ]);
  const rate = toNumber(current.data?.[0]?.fundingRate);
  const rates = (history.data || []).map((row) => toNumber(row.realizedRate ?? row.fundingRate)).filter((value): value is number => value != null);
  // Rows are [ts, openInterest(USD), volume], newest first.
  const series = (oi.data || []).map((row) => toNumber(row[1])).filter((value): value is number => value != null);
  const latest = series[0];
  const dayAgo = series[24];
  return {
    source: 'OKX perpetual swaps (fallback)',
    fundingRatePct: rate == null ? null : rate * 100,
    fundingPercentile: rate == null ? null : percentileRank(rate, rates),
    openInterest: latest ?? null,
    openInterestChangePct: latest != null && dayAgo ? ((latest - dayAgo) / dayAgo) * 100 : null,
    basisPct: toNumber(current.data?.[0]?.premium) == null ? null : toNumber(current.data?.[0]?.premium)! * 100,
    orderBookImbalance: null
  };
}

/** Binance first; OKX when Binance futures are unreachable (e.g. HTTP 451 from US hosts). */
export async function fetchCryptoDerivatives(): Promise<CryptoDerivatives> {
  try {
    return await binanceDerivatives();
  } catch (binanceError) {
    try {
      return await okxDerivatives();
    } catch {
      throw binanceError;
    }
  }
}

export async function fetchSpotOrderBookImbalance() {
  const book = await fetchJson<{ bids?: Array<[string, string]>; asks?: Array<[string, string]> }>(
    'https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=500'
  );
  return orderBookImbalance(book.bids || [], book.asks || []);
}
