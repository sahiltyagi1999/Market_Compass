import { describe, expect, it } from 'vitest';
import {
  applyScoreCalibration,
  chronologicalSplit,
  classificationReport,
  evaluate,
  fitScoreCalibration,
  nonOverlapping,
  wilsonInterval,
  type EvaluatedSample
} from './evaluation.js';

const sample = (startAt: number, endAt: number, predicted: EvaluatedSample['predicted'], actual: EvaluatedSample['actual'], extra: Partial<EvaluatedSample> = {}): EvaluatedSample => ({
  startAt,
  endAt,
  predicted,
  actual,
  ...extra
});

describe('evaluation metrics', () => {
  it('builds the confusion matrix, accuracy and per-class precision/recall', () => {
    const report = classificationReport([
      sample(0, 1, 'BULLISH', 'UP'),
      sample(1, 2, 'BULLISH', 'DOWN'),
      sample(2, 3, 'BEARISH', 'DOWN'),
      sample(3, 4, 'NEUTRAL', 'NEUTRAL'),
      sample(4, 5, 'NEUTRAL', 'UP')
    ]);
    expect(report.n).toBe(5);
    expect(report.accuracy).toBe(0.6);
    expect(report.confusion.UP.UP).toBe(1);
    expect(report.confusion.DOWN.UP).toBe(1);
    expect(report.perClass.UP.precision).toBe(0.5);
    expect(report.perClass.UP.recall).toBe(0.5);
    expect(report.perClass.DOWN.recall).toBe(0.5);
    expect(report.perClass.NEUTRAL.recall).toBe(1);
    expect(report.balancedAccuracy).toBeCloseTo((0.5 + 0.5 + 1) / 3, 4);
  });

  it('computes Brier score and log loss only when probabilities exist', () => {
    const perfect = classificationReport([sample(0, 1, 'BULLISH', 'UP', { probabilities: { UP: 1, NEUTRAL: 0, DOWN: 0 } })]);
    expect(perfect.brier).toBe(0);
    const uniform = classificationReport([sample(0, 1, 'BULLISH', 'UP', { probabilities: { UP: 1 / 3, NEUTRAL: 1 / 3, DOWN: 1 / 3 } })]);
    expect(uniform.brier).toBeCloseTo(2 / 3, 4);
    expect(uniform.logLoss).toBeCloseTo(Math.log(3), 4);
    expect(classificationReport([sample(0, 1, 'BULLISH', 'UP')]).brier).toBeNull();
  });

  it('selects non-overlapping windows chronologically', () => {
    const hourly = Array.from({ length: 10 }, (_, index) => sample(index, index + 3, 'NEUTRAL', 'NEUTRAL'));
    expect(nonOverlapping(hourly).map((item) => item.startAt)).toEqual([0, 3, 6, 9]);
  });

  it('reports the always-neutral baseline on the independent sample', () => {
    const report = evaluate([
      sample(0, 1, 'BULLISH', 'UP'),
      sample(1, 2, 'BULLISH', 'NEUTRAL'),
      sample(2, 3, 'BEARISH', 'NEUTRAL')
    ]);
    expect(report.nonOverlapping.n).toBe(3);
    expect(report.baselines.alwaysNeutral.accuracy).toBeCloseTo(2 / 3, 4);
  });

  it('computes a Wilson interval', () => {
    const interval = wilsonInterval(50, 100)!;
    expect(interval.low).toBeCloseTo(0.4038, 3);
    expect(interval.high).toBeCloseTo(0.5962, 3);
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it('purges test samples that start before the last training outcome is known', () => {
    const rows = Array.from({ length: 10 }, (_, index) => sample(index * 10, index * 10 + 25, 'NEUTRAL', 'NEUTRAL'));
    const { train, test } = chronologicalSplit(rows, 0.5);
    const trainEnd = Math.max(...train.map((row) => row.endAt));
    expect(test.every((row) => row.startAt >= trainEnd)).toBe(true);
    expect(train.length + test.length).toBeLessThan(rows.length);
  });

  it('fits score-bin calibration on training data only', () => {
    const train = [
      ...Array.from({ length: 30 }, (_, index) => sample(index, index + 1, 'BULLISH', 'UP', { score: 60 })),
      ...Array.from({ length: 30 }, (_, index) => sample(100 + index, 101 + index, 'NEUTRAL', 'NEUTRAL', { score: 0 }))
    ];
    const calibration = fitScoreCalibration(train);
    const strong = applyScoreCalibration(calibration, 70);
    expect(strong.UP).toBeGreaterThan(0.9);
    expect(strong.UP + strong.NEUTRAL + strong.DOWN).toBeCloseTo(1, 10);
    // Laplace smoothing: an unseen bin is uniform, never 0/1.
    const unseen = applyScoreCalibration(calibration, -80);
    expect(unseen.DOWN).toBeCloseTo(1 / 3, 10);
  });
});
