import { calculateTechnicals, cleanCandles, returnOverBars } from '../indicators.js';
import { istDateKey, marketStatus, previousTradingDay, sessionBounds } from '../marketSession.js';
import type { Candle, CryptoSnapshot, NiftySnapshot } from '../types.js';

const HOUR = 60 * 60_000;
const FIVE_MIN = 5 * 60_000;

/**
 * Historical dataset format (all times epoch ms UTC, candle `time` = candle
 * OPEN time; a candle is known only after time + interval).
 */
export interface CryptoHistory {
  intervalMs: number;
  btc: Candle[];
  eth: Candle[];
  /** Fixed basket used for breadth (should include BTC and ETH). */
  basket: Record<string, Candle[]>;
  /** Alternative.me daily values; `time` = 00:00 UTC of the day the value describes. */
  fearGreed: Array<{ time: number; value: number; label?: string }>;
}

export interface NiftyHistory {
  intervalMs: number;
  nifty: Candle[];
  vix: Candle[];
}

// Candle arrays are sorted ascending (see normaliseHistory); index them once.
const indexes = new WeakMap<Candle[], Map<number, number>>();
function indexOf(candles: Candle[]) {
  let index = indexes.get(candles);
  if (!index) {
    index = new Map(candles.map((candle, position) => [candle.time, position]));
    indexes.set(candles, index);
  }
  return index;
}

/** Candles whose close (time + interval) is at or before `at`: what was knowable then. Input must be sorted. */
export function knownAt(candles: Candle[], intervalMs: number, at: number, limit = Infinity) {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (candles[mid].time + intervalMs <= at) low = mid + 1;
    else high = mid;
  }
  return candles.slice(Number.isFinite(limit) ? Math.max(0, low - limit) : 0, low);
}

/** Close of the candle that closes exactly at `at` (start or end price of a window). */
export function closeAt(candles: Candle[], intervalMs: number, at: number) {
  const position = indexOf(candles).get(at - intervalMs);
  return position == null ? undefined : candles[position].close;
}

function changeOver(candles: Candle[], intervalMs: number, at: number, windowMs: number) {
  const now = closeAt(candles, intervalMs, at);
  const then = closeAt(candles, intervalMs, at - windowMs);
  return now != null && then ? ((now - then) / then) * 100 : undefined;
}

/**
 * Fear & Greed for day D is stamped 00:00 UTC of D and its exact publication
 * time is undocumented, so a value is only used from one hour after its stamp.
 */
export function fearGreedKnownAt(series: CryptoHistory['fearGreed'], at: number) {
  let best: CryptoHistory['fearGreed'][number] | undefined;
  for (const point of series) {
    if (point.time + HOUR <= at && (!best || point.time > best.time)) best = point;
  }
  return best;
}

/**
 * Snapshot of what the live crypto desk would have seen at `at`, built only
 * from data knowable at `at`. Spreads, news, derivatives and global market
 * cap have no reliable history and are left missing (as the live model does
 * when a provider fails).
 */
export function cryptoSnapshotAt(history: CryptoHistory, at: number): CryptoSnapshot | null {
  const interval = history.intervalMs;
  const btcKnown = knownAt(history.btc, interval, at, 150);
  if (btcKnown.length < 60 || btcKnown[btcKnown.length - 1].time + interval !== at) return null;
  const moves = Object.values(history.basket)
    .map((candles) => changeOver(candles, interval, at, 24 * HOUR))
    .filter((value): value is number => value != null);
  const fearGreed = fearGreedKnownAt(history.fearGreed, at);
  return {
    btcPrice: btcKnown[btcKnown.length - 1].close,
    btcChangePct: changeOver(history.btc, interval, at, 24 * HOUR),
    ethChangePct: changeOver(history.eth, interval, at, 24 * HOUR),
    btcReturn1hPct: returnOverBars(btcKnown, 1),
    btcReturn4hPct: returnOverBars(btcKnown, 4),
    breadthPositiveRatio: moves.length >= 5 ? moves.filter((value) => value > 0).length / moves.length : undefined,
    basketAverageChangePct: moves.length >= 5 ? moves.reduce((sum, value) => sum + value, 0) / moves.length : undefined,
    fearGreed: fearGreed?.value,
    fearGreedLabel: fearGreed?.label,
    technical: calculateTechnicals(btcKnown),
    updatedAt: new Date(at).toISOString()
  };
}

/**
 * Snapshot of the NIFTY desk at `at` from index and VIX 5m candles only.
 * Options, breadth, futures volume and news have no stored history here, so
 * this replays the technical analyst and the VIX part of the risk check.
 */
export function niftySnapshotAt(history: NiftyHistory, at: number): NiftySnapshot | null {
  const status = marketStatus(at);
  if (!status.open) return null;
  const session = istDateKey(at);
  const sessionStart = sessionBounds(session).open;
  const interval = history.intervalMs;
  // The previous session is whichever day last traded in the data (holidays are implicit).
  const lastBefore = knownAt(history.nifty, interval, sessionStart, 1)[0];
  const warmup = lastBefore ? istDateKey(lastBefore.time) : previousTradingDay(session);
  const relevant = (candles: Candle[]) => knownAt(candles, interval, at, 400).filter((candle) => [warmup, session].includes(istDateKey(candle.time)));
  const nifty = relevant(history.nifty);
  const sessionCandles = nifty.filter((candle) => candle.time >= sessionStart);
  if (!sessionCandles.length || sessionCandles[sessionCandles.length - 1].time + interval !== at) return null;
  const previousClose = nifty.filter((candle) => istDateKey(candle.time) === warmup).at(-1)?.close;
  const vix = relevant(history.vix);
  const vixPrevious = vix.filter((candle) => istDateKey(candle.time) === warmup).at(-1)?.close;
  const vixNow = vix.filter((candle) => candle.time >= sessionStart).at(-1)?.close;
  return {
    spot: sessionCandles[sessionCandles.length - 1].close,
    previousClose,
    sessionOpen: sessionCandles[0].open,
    vix: vixNow,
    vixPreviousClose: vixPrevious,
    technical: calculateTechnicals(nifty, { sessionStart }),
    updatedAt: new Date(at).toISOString()
  };
}

export function normaliseHistory<T extends CryptoHistory | NiftyHistory>(history: T): T {
  const clean = (candles: Candle[]) => cleanCandles(candles);
  if ('btc' in history) {
    return {
      ...history,
      btc: clean(history.btc),
      eth: clean(history.eth),
      basket: Object.fromEntries(Object.entries(history.basket).map(([key, candles]) => [key, clean(candles)])),
      fearGreed: [...history.fearGreed].sort((left, right) => left.time - right.time)
    };
  }
  return { ...history, nifty: clean(history.nifty), vix: clean(history.vix) };
}

export { FIVE_MIN, HOUR };
