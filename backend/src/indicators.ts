import type { Candle, TechnicalSnapshot } from './types.js';

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Minimum closes before an indicator is reported. Wilder RSI and seeded EMAs
 * need several periods to forget their seed, so "enough candles to compute"
 * is not the same as "enough candles to trust".
 */
export const WARMUP = {
  rsiPeriod: 14,
  rsi: 42,
  emaFast: 12,
  emaSlow: 26,
  ema: 52,
  macdSignal: 9,
  atrPeriod: 14,
  efficiencyLookback: 20,
  /** Session candles needed before session-only momentum is reported. */
  sessionMomentum: 7
} as const;

export interface TechnicalOptions {
  /**
   * Epoch ms where the current session starts. Candles before it are used
   * only to warm up RSI/EMA/MACD; momentum, volatility, ATR and regime use
   * current-session candles so overnight gaps are not counted as intraday moves.
   */
  sessionStart?: number;
  /** Candles for the momentum return (default 12). */
  momentumLookback?: number;
  /** Candles of returns for realised volatility (default 24). */
  volatilityWindow?: number;
}

/** Sort ascending, drop invalid rows and keep the last row per timestamp. */
export function cleanCandles(input: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const candle of input) {
    const values = [candle.time, candle.open, candle.high, candle.low, candle.close];
    if (!values.every(Number.isFinite)) continue;
    if (candle.close <= 0 || candle.high < candle.low) continue;
    byTime.set(candle.time, { ...candle, volume: Number.isFinite(candle.volume) ? candle.volume : 0 });
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function emaSeries(values: number[], period: number) {
  if (period <= 0 || values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const output = Array(period - 1).fill(Number.NaN) as number[];
  let current = mean(values.slice(0, period));
  output.push(current);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    output.push(current);
  }
  return output;
}

/** Wilder RSI seeded with a simple average of the first `period` changes. */
export function rsi(values: number[], period = 14) {
  if (values.length <= period) return undefined;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(change, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0 && averageGain === 0) return 50;
  if (averageLoss === 0) return 100;
  return 100 - (100 / (1 + averageGain / averageLoss));
}

/** Population standard deviation. */
export function standardDeviation(values: number[]) {
  if (values.length < 2) return undefined;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

/** Wilder ATR. The first candle of a session uses high-low (no overnight gap). */
export function atr(candles: Candle[], period = 14, sessionStart?: number) {
  if (candles.length <= period) return undefined;
  const ranges = candles.slice(1).map((candle, index) => {
    const previous = candles[index];
    const crossesSession = sessionStart != null && previous.time < sessionStart && candle.time >= sessionStart;
    if (crossesSession) return candle.high - candle.low;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close));
  });
  let value = mean(ranges.slice(0, period));
  for (let index = period; index < ranges.length; index += 1) {
    value = (value * (period - 1) + ranges[index]) / period;
  }
  return value;
}

/** Kaufman efficiency ratio: net move / total path over the lookback. */
export function efficiencyRatio(closes: number[], lookback = 20) {
  if (closes.length <= lookback) return undefined;
  const window = closes.slice(-(lookback + 1));
  const path = window.slice(1).reduce((sum, close, index) => sum + Math.abs(close - window[index]), 0);
  if (path === 0) return 0;
  return Math.abs(window[window.length - 1] - window[0]) / path;
}

/** Volume-weighted average of typical price over candles with volume. */
export function vwap(candles: Candle[]) {
  let priceVolume = 0;
  let volume = 0;
  for (const candle of candles) {
    if (!(candle.volume > 0)) continue;
    priceVolume += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
    volume += candle.volume;
  }
  return volume > 0 ? priceVolume / volume : undefined;
}

/** % return between the last close and the close `bars` candles earlier. */
export function returnOverBars(candles: Candle[], bars: number) {
  if (bars <= 0 || candles.length <= bars) return undefined;
  const latest = candles[candles.length - 1].close;
  const base = candles[candles.length - 1 - bars].close;
  return base > 0 ? ((latest - base) / base) * 100 : undefined;
}

export function calculateTechnicals(input: Candle[], options: TechnicalOptions = {}): TechnicalSnapshot {
  const candles = cleanCandles(input);
  const closes = candles.map((candle) => candle.close);
  const sessionCandles = options.sessionStart == null
    ? candles
    : candles.filter((candle) => candle.time >= options.sessionStart!);
  const sessionCloses = sessionCandles.map((candle) => candle.close);
  const snapshot: TechnicalSnapshot = {
    candleCount: closes.length,
    sessionCandleCount: sessionCloses.length,
    lastCandleAt: candles.at(-1)?.time
  };
  if (!closes.length) return snapshot;
  const latest = closes[closes.length - 1];

  if (closes.length >= WARMUP.rsi) snapshot.rsi = rsi(closes, WARMUP.rsiPeriod);

  if (closes.length >= WARMUP.ema) {
    const fast = emaSeries(closes, WARMUP.emaFast);
    const slow = emaSeries(closes, WARMUP.emaSlow);
    snapshot.emaFast = fast.at(-1);
    snapshot.emaSlow = slow.at(-1);
    if (snapshot.emaFast != null && snapshot.emaSlow) {
      snapshot.emaSpreadPct = ((snapshot.emaFast - snapshot.emaSlow) / snapshot.emaSlow) * 100;
    }
    const macdValues = closes
      .map((_, index) => Number.isFinite(fast[index]) && Number.isFinite(slow[index]) ? fast[index] - slow[index] : Number.NaN)
      .filter(Number.isFinite);
    const signalValues = emaSeries(macdValues, WARMUP.macdSignal);
    const macd = macdValues.at(-1);
    const signal = signalValues.at(-1);
    if (macd != null && signal != null && Number.isFinite(signal)) {
      snapshot.macdHistogramPct = ((macd - signal) / latest) * 100;
    }
  }

  const lookback = options.momentumLookback ?? 12;
  const minimumSession = options.sessionStart == null ? lookback + 1 : WARMUP.sessionMomentum;
  if (sessionCloses.length >= minimumSession) {
    const bars = Math.min(lookback, sessionCloses.length - 1);
    const base = sessionCloses[sessionCloses.length - 1 - bars];
    if (base > 0) snapshot.recentMomentumPct = ((latest - base) / base) * 100;
  }

  const window = options.volatilityWindow ?? 24;
  const recent = sessionCloses.slice(-(window + 1));
  const returns = recent.slice(1).map((close, index) => ((close - recent[index]) / recent[index]) * 100);
  if (returns.length >= Math.min(window, 6)) snapshot.volatilityPct = standardDeviation(returns);

  const range = atr(candles, WARMUP.atrPeriod, options.sessionStart);
  if (range != null) snapshot.atrPct = (range / latest) * 100;

  const efficiency = efficiencyRatio(sessionCloses, WARMUP.efficiencyLookback);
  if (efficiency != null) {
    snapshot.efficiencyRatio = efficiency;
    // 0.3 is a common rule-of-thumb split; it is a label, not a scored input.
    snapshot.regime = efficiency >= 0.3 ? 'trending' : 'range-bound';
  }
  return snapshot;
}

/**
 * Relative volume: cumulative volume this session up to `asOf` (time of day)
 * divided by the average cumulative volume of previous sessions up to the
 * same offset from their session start.
 */
export function relativeVolume(
  current: { start: number; candles: Candle[] },
  previous: Array<{ start: number; candles: Candle[] }>,
  asOf: number
) {
  const offset = asOf - current.start;
  if (offset <= 0) return undefined;
  const cumulative = (session: { start: number; candles: Candle[] }) => session.candles
    .filter((candle) => candle.time - session.start < offset)
    .reduce((sum, candle) => sum + (candle.volume > 0 ? candle.volume : 0), 0);
  const now = cumulative(current);
  const history = previous.map(cumulative).filter((value) => value > 0);
  if (!history.length || now <= 0) return undefined;
  return now / mean(history);
}
