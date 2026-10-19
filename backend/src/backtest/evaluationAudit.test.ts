import { describe, expect, it } from 'vitest';
import { bootstrap, classificationReport, probabilityReport, rocAuc, skillScore, type EvaluatedSample } from '../evaluation.js';
import { fitModels, type Prepared } from './engine.js';
import { argmaxClass, fitLogistic, predictLogistic } from './logistic.js';
import { benchmarks, simulateStrategy, type StrategyWindow } from './trading.js';

const sample = (predicted: EvaluatedSample['predicted'], actual: EvaluatedSample['actual'], index = 0): EvaluatedSample => ({ startAt: index, endAt: index + 1, predicted, actual });

describe('classification metrics', () => {
  it('computes macro-F1 and class distributions by hand', () => {
    // UP: P=1/2 R=1/2 F1=.5 ; NEUTRAL: P=1 R=1/2 F1=2/3 ; DOWN: P=1/2 R=1 F1=2/3
    const report = classificationReport([
      sample('BULLISH', 'UP'), sample('BULLISH', 'NEUTRAL'), sample('NEUTRAL', 'NEUTRAL'),
      sample('BEARISH', 'DOWN'), sample('BEARISH', 'UP')
    ]);
    expect(report.perClass.UP.f1).toBeCloseTo(0.5, 4);
    expect(report.perClass.NEUTRAL.f1).toBeCloseTo(2 / 3, 4);
    expect(report.perClass.DOWN.f1).toBeCloseTo(2 / 3, 4);
    expect(report.macroF1).toBeCloseTo((0.5 + 2 / 3 + 2 / 3) / 3, 4);
    expect(report.actualDistribution).toEqual({ UP: 2, NEUTRAL: 2, DOWN: 1 });
    expect(report.predictedDistribution).toEqual({ UP: 2, NEUTRAL: 1, DOWN: 2 });
  });

  it('gives a constant majority classifier zero F1 on the classes it never predicts', () => {
    const report = classificationReport([sample('NEUTRAL', 'NEUTRAL'), sample('NEUTRAL', 'UP'), sample('NEUTRAL', 'DOWN')]);
    expect(report.perClass.UP.f1).toBe(0);
    expect(report.macroF1).toBeCloseTo(0.5 / 3, 4);
    expect(report.balancedAccuracy).toBeCloseTo(1 / 3, 4);
  });
});

describe('probability metrics', () => {
  const items = (vector: { UP: number; NEUTRAL: number; DOWN: number }, actuals: Array<'UP' | 'NEUTRAL' | 'DOWN'>) => actuals.map((actual) => ({ probabilities: vector, actual }));

  it('uses the standard summed multiclass Brier score (uniform = 2/3, log loss = ln 3)', () => {
    const report = probabilityReport(items({ UP: 1 / 3, NEUTRAL: 1 / 3, DOWN: 1 / 3 }, ['UP', 'DOWN', 'NEUTRAL', 'UP']));
    expect(report.brier).toBeCloseTo(2 / 3, 4);
    expect(report.logLoss).toBeCloseTo(Math.log(3), 4);
    expect(probabilityReport(items({ UP: 1, NEUTRAL: 0, DOWN: 0 }, ['UP'])).brier).toBe(0);
    expect(probabilityReport(items({ UP: 1, NEUTRAL: 0, DOWN: 0 }, ['DOWN'])).brier).toBe(2);
  });

  it('decomposes Brier into reliability, resolution and uncertainty', () => {
    // Climatology forecast: perfectly reliable, zero resolution, Brier = uncertainty.
    const actuals: Array<'UP' | 'NEUTRAL' | 'DOWN'> = ['UP', 'UP', 'NEUTRAL', 'DOWN'];
    const report = probabilityReport(items({ UP: 0.5, NEUTRAL: 0.25, DOWN: 0.25 }, actuals));
    expect(report.reliability).toBeCloseTo(0, 6);
    expect(report.resolution).toBeCloseTo(0, 6);
    expect(report.brier).toBeCloseTo(report.uncertainty!, 4);
    expect(report.reliabilityBins.UP[0]).toMatchObject({ n: 4, meanForecast: 0.5, observedFrequency: 0.5 });
  });

  it('computes skill relative to a reference', () => {
    expect(skillScore(0.6, 0.65)).toBeCloseTo(0.0769, 3);
    expect(skillScore(0.7, 0.65)).toBeLessThan(0);
    expect(skillScore(null, 0.65)).toBeNull();
  });

  it('computes ROC AUC with ties', () => {
    expect(rocAuc([1, 2, 3, 4], [false, false, true, true])).toBe(1);
    expect(rocAuc([4, 3, 2, 1], [false, false, true, true])).toBe(0);
    expect(rocAuc([1, 1, 1, 1], [false, true, false, true])).toBe(0.5);
    expect(rocAuc([1, 2], [true, true])).toBeNull();
  });

  it('produces reproducible seeded bootstrap intervals', () => {
    const values = Array.from({ length: 200 }, (_, index) => (index % 3 === 0 ? 1 : 0));
    const statistic = (indices: number[]) => indices.reduce((sum, index) => sum + values[index], 0) / indices.length;
    const first = bootstrap(values.length, statistic, 300, 7);
    const second = bootstrap(values.length, statistic, 300, 7);
    expect(first).toEqual(second);
    expect(first.low!).toBeLessThan(first.estimate!);
    expect(first.high!).toBeGreaterThan(first.estimate!);
  });
});

describe('fitting uses training rows only', () => {
  const prepared = (index: number, returnPct: number, score: number): Prepared => ({
    observation: { at: index * 10, targetAt: index * 10 + 6, snapshot: {}, startPrice: 100, endPrice: 100 * (1 + returnPct / 100), priorReturnPct: 0 },
    startAt: index * 10,
    endAt: index * 10 + 6,
    returnPct,
    score,
    heuristic: { UP: 0.4, NEUTRAL: 0.3, DOWN: 0.3 },
    features: [score / 10, returnPct > 0 ? 1 : -1]
  });
  const options = { market: 'crypto' as const, verdictThresholds: [10, 30], lambdas: [0.01, 1], logisticIterations: 50 };

  it('learns base rates, verdict threshold and calibration from the given rows only', () => {
    const train = Array.from({ length: 60 }, (_, index) => prepared(index, index % 2 ? 0.5 : -0.5, index % 2 ? 40 : -40));
    const models = fitModels(train, 0.2, options);
    expect(models.trainFrequencies.UP).toBeCloseTo(31 / 63, 4);
    expect(models.majorityClass === 'UP' || models.majorityClass === 'DOWN').toBe(true);
    expect(models.apply.calibrated(40).UP).toBeGreaterThan(0.9);
    // Same training rows, different "future" rows -> identical fit.
    const again = fitModels([...train], 0.2, options);
    expect(again.verdictThreshold).toBe(models.verdictThreshold);
    expect(again.logistic.weights).toEqual(models.logistic.weights);
  });
});

describe('logistic regression', () => {
  it('learns a separable rule and imputes missing values from training means', () => {
    const rows = Array.from({ length: 120 }, (_, index) => [index % 3 === 0 ? 2 : index % 3 === 1 ? 0 : -2]);
    const labels = rows.map(([value]) => (value > 0 ? 'UP' : value < 0 ? 'DOWN' : 'NEUTRAL') as 'UP' | 'NEUTRAL' | 'DOWN');
    const model = fitLogistic(['x'], rows, labels, { lambda: 0.001, iterations: 400 });
    expect(argmaxClass(predictLogistic(model, [2]))).toBe('UP');
    expect(argmaxClass(predictLogistic(model, [-2]))).toBe('DOWN');
    expect(argmaxClass(predictLogistic(model, [undefined]))).toBe('NEUTRAL');
    expect(model.means[0]).toBeCloseTo(0, 6);
  });
});

describe('trading simulation', () => {
  const window = (index: number, returnPct: number, predicted: StrategyWindow['predicted']): StrategyWindow => ({ startAt: index * 10, endAt: index * 10 + 6, returnPct, predicted });

  it('never trades on NEUTRAL or UNAVAILABLE and reports zero for no trades', () => {
    const stats = simulateStrategy([window(0, 5, 'NEUTRAL'), window(1, -5, 'UNAVAILABLE')], 0.2);
    expect(stats.trades).toBe(0);
    expect(stats.compoundedReturnPct).toBe(0);
    expect(stats.winRate).toBeNull();
    expect(stats.exposure).toBe(0);
  });

  it('compounds net returns, separates additive totals and charges costs per trade', () => {
    const stats = simulateStrategy([window(0, 10, 'BULLISH'), window(1, 10, 'BEARISH'), window(2, -10, 'BEARISH')], 1);
    // nets: +9, -11, +9 ; equity 1.09 * 0.89 * 1.09
    expect(stats.additiveReturnPct).toBeCloseTo(7, 6);
    expect(stats.compoundedReturnPct).toBeCloseTo((1.09 * 0.89 * 1.09 - 1) * 100, 2);
    expect(stats.totalCostsPct).toBe(3);
    expect(stats.longs).toBe(1);
    expect(stats.shorts).toBe(2);
    expect(stats.maxDrawdownPct).toBeCloseTo(11, 4);
    expect(stats.profitFactor).toBeCloseTo(18 / 11, 2);
  });

  it('rejects overlapping windows (one position at a time)', () => {
    expect(() => simulateStrategy([window(0, 1, 'BULLISH'), { ...window(0, 1, 'BULLISH'), startAt: 3, endAt: 9 }], 0)).toThrow();
  });

  it('reports passive benchmarks on the same period', () => {
    const windows = [window(0, 1, 'NEUTRAL'), window(1, 2, 'NEUTRAL')];
    const result = benchmarks(windows, 100, 110, 0.2);
    expect(result.noTrade.compoundedReturnPct).toBe(0);
    expect(result.alwaysLongSameWindows.trades).toBe(2);
    expect(result.buyAndHoldPct).toBeCloseTo(9.8, 6);
  });
});
