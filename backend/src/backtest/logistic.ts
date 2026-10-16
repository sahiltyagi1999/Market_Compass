import { OUTCOME_CLASSES, type OutcomeClass } from '../outcomes.js';
import type { ProbabilityVector } from '../evaluation.js';

/**
 * Multinomial logistic regression with L2 penalty (intercepts unpenalised),
 * fitted by deterministic full-batch gradient descent. Standardisation
 * statistics and missing-value imputation (training mean) come from the
 * training rows only, so nothing leaks from evaluation data.
 */
export interface LogisticModel {
  featureNames: string[];
  means: number[];
  stds: number[];
  /** weights[class][0] is the intercept; weights[class][j + 1] is feature j. */
  weights: number[][];
  lambda: number;
  iterations: number;
  trainedOn: number;
}

export interface FitOptions {
  lambda: number;
  iterations?: number;
  learningRate?: number;
}

type Row = Array<number | undefined>;

function standardiser(rows: Row[], width: number) {
  const means: number[] = [];
  const stds: number[] = [];
  for (let j = 0; j < width; j += 1) {
    const values = rows.map((row) => row[j]).filter((value): value is number => value != null && Number.isFinite(value));
    const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const variance = values.length ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length : 0;
    means.push(mean);
    stds.push(variance > 1e-12 ? Math.sqrt(variance) : 1);
  }
  return { means, stds };
}

function transform(row: Row, means: number[], stds: number[]) {
  // Missing -> training mean -> 0 after standardisation.
  return means.map((mean, j) => {
    const value = row[j];
    return value == null || !Number.isFinite(value) ? 0 : (value - mean) / stds[j];
  });
}

function softmax(logits: number[]) {
  const max = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

export function fitLogistic(featureNames: string[], rows: Row[], labels: OutcomeClass[], options: FitOptions): LogisticModel {
  const width = featureNames.length;
  const { means, stds } = standardiser(rows, width);
  const x = rows.map((row) => transform(row, means, stds));
  const y = labels.map((label) => OUTCOME_CLASSES.indexOf(label));
  const k = OUTCOME_CLASSES.length;
  const n = x.length;
  const weights = Array.from({ length: k }, () => new Array(width + 1).fill(0));
  const iterations = options.iterations ?? 300;
  const rate = options.learningRate ?? 0.5;
  if (!n) return { featureNames, means, stds, weights, lambda: options.lambda, iterations: 0, trainedOn: 0 };
  // Flat typed arrays: this loop runs ~10^9 multiply-adds per backtest.
  const stride = width + 1;
  const flat = new Float64Array(n * stride);
  for (let i = 0; i < n; i += 1) {
    flat[i * stride] = 1;
    for (let j = 0; j < width; j += 1) flat[i * stride + j + 1] = x[i][j];
  }
  const w = new Float64Array(k * stride);
  const gradient = new Float64Array(k * stride);
  const logits = new Float64Array(k);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    gradient.fill(0);
    for (let i = 0; i < n; i += 1) {
      const offset = i * stride;
      let max = -Infinity;
      for (let c = 0; c < k; c += 1) {
        let sum = 0;
        for (let j = 0; j < stride; j += 1) sum += flat[offset + j] * w[c * stride + j];
        logits[c] = sum;
        if (sum > max) max = sum;
      }
      let total = 0;
      for (let c = 0; c < k; c += 1) {
        logits[c] = Math.exp(logits[c] - max);
        total += logits[c];
      }
      for (let c = 0; c < k; c += 1) {
        const error = logits[c] / total - (y[i] === c ? 1 : 0);
        for (let j = 0; j < stride; j += 1) gradient[c * stride + j] += error * flat[offset + j];
      }
    }
    for (let c = 0; c < k; c += 1) {
      w[c * stride] -= rate * gradient[c * stride] / n;
      for (let j = 1; j < stride; j += 1) {
        w[c * stride + j] -= rate * (gradient[c * stride + j] / n + options.lambda * w[c * stride + j]);
      }
    }
  }
  for (let c = 0; c < k; c += 1) for (let j = 0; j < stride; j += 1) weights[c][j] = w[c * stride + j];
  return { featureNames, means, stds, weights, lambda: options.lambda, iterations, trainedOn: n };
}

export function predictLogistic(model: LogisticModel, row: Row): ProbabilityVector {
  const xi = transform(row, model.means, model.stds);
  const probabilities = softmax(model.weights.map((w) => w[0] + xi.reduce((sum, value, j) => sum + value * w[j + 1], 0)));
  return Object.fromEntries(OUTCOME_CLASSES.map((cls, index) => [cls, probabilities[index]])) as ProbabilityVector;
}

export function argmaxClass(probabilities: ProbabilityVector): OutcomeClass {
  return OUTCOME_CLASSES.reduce((best, cls) => probabilities[cls] > probabilities[best] ? cls : best, OUTCOME_CLASSES[0]);
}
