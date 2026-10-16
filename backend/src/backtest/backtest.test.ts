import { describe, expect, it } from 'vitest';
import { istTime } from '../marketSession.js';
import type { Candle } from '../types.js';
import { developmentTestSplit, runBacktest, walkForwardFolds } from './engine.js';
import { cryptoObservations, niftyObservations } from './observations.js';
import { closeAt, cryptoSnapshotAt, fearGreedKnownAt, HOUR, knownAt, type CryptoHistory } from './replay.js';

// SYNTHETIC DATA — for unit tests of timestamp alignment only, never for results.
function syntheticHourly(count: number, start = Date.parse('2026-01-01T00:00:00Z'), drift = 0.1): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + Math.sin(index / 5) * 2 + index * drift;
    return { time: start + index * HOUR, open: close, high: close + 0.5, low: close - 0.5, close, volume: 10 };
  });
}

function syntheticHistory(count = 300): CryptoHistory {
  const btc = syntheticHourly(count);
  return {
    intervalMs: HOUR,
    btc,
    eth: syntheticHourly(count, btc[0].time, 0.05),
    basket: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((key, index) => [key, syntheticHourly(count, btc[0].time, index % 2 ? 0.1 : -0.1)])),
    fearGreed: [{ time: btc[0].time, value: 40 }, { time: btc[0].time + 24 * HOUR, value: 70 }]
  };
}

describe('backtest timestamp alignment', () => {
  it('only exposes candles that had closed at the decision time', () => {
    const candles = syntheticHourly(10);
    const at = candles[4].time + HOUR;
    const known = knownAt(candles, HOUR, at);
    expect(known.at(-1)!.time).toBe(candles[4].time);
    expect(known.every((candle) => candle.time + HOUR <= at)).toBe(true);
    expect(closeAt(candles, HOUR, at)).toBe(candles[4].close);
  });

  it('uses the daily Fear & Greed value only one hour after its stamp', () => {
    const series = [{ time: 0, value: 10 }, { time: 24 * HOUR, value: 90 }];
    expect(fearGreedKnownAt(series, 24 * HOUR + 30 * 60_000)?.value).toBe(10);
    expect(fearGreedKnownAt(series, 25 * HOUR)?.value).toBe(90);
  });

  it('builds snapshots that cannot see the future', () => {
    const history = syntheticHistory();
    const at = history.btc[200].time + HOUR;
    const snapshot = cryptoSnapshotAt(history, at)!;
    // Changing every candle after `at` must not change the snapshot.
    const tampered: CryptoHistory = {
      ...history,
      btc: history.btc.map((candle) => candle.time + HOUR > at ? { ...candle, close: candle.close * 10 } : candle)
    };
    expect(cryptoSnapshotAt(tampered, at)).toEqual(snapshot);
  });

  it('pairs each observation with the close exactly one horizon later', () => {
    const history = syntheticHistory();
    const observations = cryptoObservations(history);
    expect(observations.length).toBeGreaterThan(100);
    for (const observation of observations.slice(0, 20)) {
      expect(observation.targetAt - observation.at).toBe(6 * HOUR);
      expect(observation.endPrice).toBe(closeAt(history.btc, HOUR, observation.targetAt));
    }
  });

  it('never lets NIFTY replay windows cross the session close', () => {
    const day = '2026-10-12';
    const previous = '2026-10-09';
    const fiveMin = 5 * 60_000;
    const session = (date: string) => Array.from({ length: 75 }, (_, index) => {
      const close = 25_000 + index;
      return { time: istTime(date, 9 * 60 + 15) + index * fiveMin, open: close, high: close + 1, low: close - 1, close, volume: 0 };
    });
    const nifty = [...session(previous), ...session(day)];
    const observations = niftyObservations({ intervalMs: fiveMin, nifty, vix: nifty.map((candle) => ({ ...candle, close: 12 })) });
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation.targetAt).toBeLessThanOrEqual(istTime(day, 15 * 60 + 30));
      expect(observation.targetAt - observation.at).toBeGreaterThanOrEqual(60 * 60_000);
    }
  });
});

describe('backtest engine (synthetic data, structure only)', () => {
  it('purges development samples whose windows reach into the test period', () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ startAt: index, endAt: index + 6 }));
    const { development, test, purged } = developmentTestSplit(rows, 0.2);
    expect(Math.max(...development.map((row) => row.endAt))).toBeLessThanOrEqual(test[0].startAt);
    expect(purged).toBe(5); // starts 75..79 end after the test starts at 80
  });

  it('builds expanding walk-forward folds whose training windows end before evaluation starts', () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ startAt: index, endAt: index + 6 }));
    const folds = walkForwardFolds(rows, 5);
    expect(folds).toHaveLength(4);
    for (const fold of folds) {
      expect(Math.max(...fold.train.map((row) => row.endAt))).toBeLessThanOrEqual(fold.evaluation[0].startAt);
    }
    expect(folds[3].train.length).toBeGreaterThan(folds[0].train.length);
  });

  it('never lets test-period outcomes influence threshold or model selection', () => {
    const observations = cryptoObservations(syntheticHistory(900));
    const options = { market: 'crypto' as const, bootstrapIterations: 50, lambdas: [0.1], logisticIterations: 30 };
    const original = runBacktest(observations, options);
    const testStart = Date.parse(original.dataset.test.from!);
    // Scramble every outcome inside the test period.
    const tampered = observations.map((observation, index) => observation.at >= testStart
      ? { ...observation, endPrice: observation.startPrice * (index % 2 ? 1.05 : 0.95) }
      : observation);
    const rerun = runBacktest(tampered, options);
    expect(rerun.selection.selectedOutcomeThreshold).toBe(original.selection.selectedOutcomeThreshold);
    expect(rerun.thresholdSensitivity).toEqual(original.thresholdSensitivity);
    expect(rerun.finalTest.map((row) => row.fitted)).toEqual(original.finalTest.map((row) => row.fitted));
    expect(rerun.finalTest[0].result.classification.handSet).not.toEqual(original.finalTest[0].result.classification.handSet);
  });

  it('scores every model and baseline on exactly the same windows and labels', () => {
    const report = runBacktest(cryptoObservations(syntheticHistory(900)), { market: 'crypto', bootstrapIterations: 50, lambdas: [0.1], logisticIterations: 30 });
    const block = report.finalTest[0].result;
    const sizes = Object.values(block.classification).map((item) => item.n);
    expect(new Set(sizes).size).toBe(1);
    const actual = Object.values(block.classification).map((item) => item.actualDistribution);
    expect(actual.every((value) => JSON.stringify(value) === JSON.stringify(actual[0]))).toBe(true);
    expect(Object.values(block.probability).every((item) => item.n === block.n)).toBe(true);
    expect(block.probability.uniform.brier).toBeCloseTo(2 / 3, 4);
    expect(block.trading!.strategies.handSet.windows).toBe(block.n);
  });
});
