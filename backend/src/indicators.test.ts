import { describe, expect, it } from 'vitest';
import {
  atr,
  calculateTechnicals,
  cleanCandles,
  efficiencyRatio,
  emaSeries,
  relativeVolume,
  returnOverBars,
  rsi,
  vwap,
  WARMUP
} from './indicators.js';
import type { Candle } from './types.js';

const candle = (time: number, close: number, extra: Partial<Candle> = {}): Candle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
  ...extra
});

describe('indicator maths (hand-computed values)', () => {
  it('seeds EMA with a simple average and then smooths', () => {
    // period 3: seed mean(1,2,3)=2; k=0.5 -> (4-2)*.5+2=3 -> (5-3)*.5+3=4
    const series = emaSeries([1, 2, 3, 4, 5], 3);
    expect(series.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(series.slice(2)).toEqual([2, 3, 4]);
    expect(emaSeries([1, 2], 3)).toEqual([]);
    expect(emaSeries([1, 2, 3], 0)).toEqual([]);
  });

  it('uses Wilder smoothing for RSI', () => {
    // period 2: changes +1,+1 seed gain 1 / loss 0; then -1 -> gain .5, loss .5 -> RSI 50
    expect(rsi([1, 2, 3, 2], 2)).toBeCloseTo(50, 10);
    expect(rsi([1, 2, 3, 4], 2)).toBe(100);
    expect(rsi([4, 3, 2, 1], 2)).toBe(0);
  });

  it('returns a neutral RSI for a flat series instead of 100', () => {
    expect(rsi([5, 5, 5, 5, 5], 2)).toBe(50);
  });

  it('computes ATR, VWAP, efficiency ratio and lookback returns', () => {
    const rows = [
      candle(0, 10, { high: 11, low: 9 }),
      candle(1, 12, { high: 13, low: 11 }),
      candle(2, 11, { high: 12, low: 10 })
    ];
    // TR: max(2, |13-10|, |11-10|)=3 ; max(2, |12-12|, |10-12|)=2 -> period 2 mean = 2.5
    expect(atr(rows, 2)).toBe(2.5);
    // typical prices 10, 12, 11 with equal volume
    expect(vwap(rows)).toBeCloseTo(11, 10);
    expect(vwap([candle(0, 10, { volume: 0 })])).toBeUndefined();
    expect(efficiencyRatio([1, 2, 3, 4, 5], 4)).toBe(1);
    expect(efficiencyRatio([1, 2, 1, 2, 1], 4)).toBe(0);
    expect(returnOverBars(rows, 2)).toBeCloseTo(10, 10);
    expect(returnOverBars(rows, 5)).toBeUndefined();
  });

  it('ignores the overnight gap in the first true range of a session', () => {
    const rows = [candle(0, 100, { high: 101, low: 99 }), candle(10, 120, { high: 121, low: 119 }), candle(11, 120, { high: 121, low: 119 })];
    expect(atr(rows, 2, 10)).toBe(2);
    expect(atr(rows, 2)).toBeGreaterThan(2);
  });

  it('sorts, de-duplicates and drops invalid candles', () => {
    const cleaned = cleanCandles([
      candle(3, 30),
      candle(1, 10),
      candle(1, 11),
      candle(2, Number.NaN),
      candle(4, 40, { high: 1, low: 2 }),
      candle(5, -1)
    ]);
    expect(cleaned.map((row) => [row.time, row.close])).toEqual([[1, 11], [3, 30]]);
  });

  it('measures relative volume against the same time of day in previous sessions', () => {
    const session = (start: number, volumes: number[]) => ({ start, candles: volumes.map((volume, index) => candle(start + index * 5, 1, { volume })) });
    const today = session(1000, [300, 300, 300]);
    const previous = [session(0, [100, 100, 100, 100]), session(500, [200, 200, 200, 200])];
    // up to offset 10: today 600 vs previous (200 + 400)/2 = 300
    expect(relativeVolume(today, previous, 1010)).toBe(2);
    expect(relativeVolume(today, [], 1010)).toBeUndefined();
  });
});

describe('calculateTechnicals', () => {
  const rising = Array.from({ length: 80 }, (_, index) => candle(index * 60_000, 100 + index, { high: 101 + index, low: 99 + index }));

  it('withholds indicators until their warm-up is complete', () => {
    const short = calculateTechnicals(rising.slice(0, WARMUP.rsi - 1));
    expect(short.rsi).toBeUndefined();
    expect(short.emaSpreadPct).toBeUndefined();
    expect(short.macdHistogramPct).toBeUndefined();
    const enough = calculateTechnicals(rising.slice(0, WARMUP.ema));
    expect(enough.rsi).toBeGreaterThan(50);
    expect(enough.emaSpreadPct).toBeGreaterThan(0);
    expect(enough.macdHistogramPct).toBeDefined();
  });

  it('returns no NaN or infinite values for empty or degenerate input', () => {
    const empty = calculateTechnicals([]);
    expect(empty.candleCount).toBe(0);
    const flat = calculateTechnicals(Array.from({ length: 60 }, (_, index) => candle(index, 100)));
    for (const value of Object.values(flat)) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
    expect(flat.rsi).toBe(50);
    expect(flat.emaSpreadPct).toBe(0);
  });

  it('computes momentum and volatility from the current session only', () => {
    const yesterday = Array.from({ length: 60 }, (_, index) => candle(index, 100));
    const sessionStart = 1_000;
    // Today gaps up 10% and then stays flat.
    const today = Array.from({ length: 10 }, (_, index) => candle(sessionStart + index, 110));
    const technical = calculateTechnicals([...yesterday, ...today], { sessionStart });
    expect(technical.sessionCandleCount).toBe(10);
    expect(technical.recentMomentumPct).toBe(0);
    expect(technical.volatilityPct).toBe(0);
    // The overnight gap still warms up the trend indicators.
    expect(technical.emaSpreadPct).toBeGreaterThan(0);
  });

  it('does not report session momentum before enough session candles exist', () => {
    const yesterday = Array.from({ length: 60 }, (_, index) => candle(index, 100));
    const technical = calculateTechnicals([...yesterday, candle(1_000, 101), candle(1_001, 102)], { sessionStart: 1_000 });
    expect(technical.recentMomentumPct).toBeUndefined();
  });
});
