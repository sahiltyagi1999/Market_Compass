import { expectedOutcome, OUTCOME_CLASSES, type OutcomeClass, type PredictedClass } from './outcomes.js';

/** One prediction with a known outcome. Times are epoch milliseconds. */
export interface EvaluatedSample {
  startAt: number;
  endAt: number;
  predicted: PredictedClass;
  actual: OutcomeClass;
  score?: number;
  /** Heuristic (uncalibrated) or calibrated class probabilities, 0-1. */
  probabilities?: Record<OutcomeClass, number>;
  returnPct?: number;
  regime?: string;
}

export interface ClassMetrics {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  support: number;
  predicted: number;
}

export interface Interval {
  low: number;
  high: number;
}

export interface ClassificationReport {
  n: number;
  accuracy: number | null;
  accuracyCi95: Interval | null;
  balancedAccuracy: number | null;
  /** Unweighted mean of per-class F1 over classes that occur (actual or predicted). */
  macroF1: number | null;
  actualDistribution: Record<OutcomeClass, number>;
  predictedDistribution: Record<OutcomeClass, number>;
  perClass: Record<OutcomeClass, ClassMetrics>;
  /** confusion[actual][predictedAsOutcome] */
  confusion: Record<OutcomeClass, Record<OutcomeClass, number>>;
  brier: number | null;
  logLoss: number | null;
}

export interface EvaluationReport {
  all: ClassificationReport;
  /** Chronologically selected samples whose return windows never overlap. */
  nonOverlapping: ClassificationReport;
  baselines: {
    alwaysNeutral: ClassificationReport;
  };
  byRegime: Record<string, ClassificationReport>;
  note: string;
}

const round = (value: number, digits = 4) => Number(value.toFixed(digits));

/** Wilson score interval for a binomial proportion (95% by default). */
export function wilsonInterval(successes: number, n: number, z = 1.96): Interval | null {
  if (n <= 0) return null;
  const p = successes / n;
  const denominator = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denominator;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denominator;
  return { low: round(Math.max(0, centre - margin)), high: round(Math.min(1, centre + margin)) };
}

/**
 * Greedy chronological selection: keep a sample only when it starts at or
 * after the previous kept sample's window ended. The result has no
 * overlapping return windows, so samples are closer to independent.
 */
export function nonOverlapping<T extends { startAt: number; endAt: number }>(samples: T[]): T[] {
  const sorted = [...samples].sort((left, right) => left.startAt - right.startAt);
  const kept: T[] = [];
  let lastEnd = -Infinity;
  for (const sample of sorted) {
    if (sample.startAt >= lastEnd) {
      kept.push(sample);
      lastEnd = sample.endAt;
    }
  }
  return kept;
}

function emptyConfusion() {
  return Object.fromEntries(OUTCOME_CLASSES.map((actual) => [
    actual,
    Object.fromEntries(OUTCOME_CLASSES.map((predicted) => [predicted, 0]))
  ])) as Record<OutcomeClass, Record<OutcomeClass, number>>;
}

export function classificationReport(samples: EvaluatedSample[]): ClassificationReport {
  const confusion = emptyConfusion();
  let correct = 0;
  for (const sample of samples) {
    const predicted = expectedOutcome(sample.predicted);
    confusion[sample.actual][predicted] += 1;
    if (predicted === sample.actual) correct += 1;
  }
  const perClass = Object.fromEntries(OUTCOME_CLASSES.map((cls) => {
    const truePositive = confusion[cls][cls];
    const support = OUTCOME_CLASSES.reduce((sum, predicted) => sum + confusion[cls][predicted], 0);
    const predictedCount = OUTCOME_CLASSES.reduce((sum, actual) => sum + confusion[actual][cls], 0);
    const precision = predictedCount ? truePositive / predictedCount : null;
    const recall = support ? truePositive / support : null;
    // F1 is 0 when a present class is never predicted or never correct; undefined when absent everywhere.
    const f1 = support || predictedCount
      ? (precision && recall ? (2 * precision * recall) / (precision + recall) : 0)
      : null;
    return [cls, {
      precision: precision == null ? null : round(precision),
      recall: recall == null ? null : round(recall),
      f1: f1 == null ? null : round(f1),
      support,
      predicted: predictedCount
    }];
  })) as Record<OutcomeClass, ClassMetrics>;
  const recalls = OUTCOME_CLASSES.map((cls) => perClass[cls].recall).filter((value): value is number => value != null);

  const withProbabilities = samples.filter((sample) => sample.probabilities);
  let brier: number | null = null;
  let logLoss: number | null = null;
  if (withProbabilities.length) {
    let brierSum = 0;
    let logSum = 0;
    for (const sample of withProbabilities) {
      const probabilities = sample.probabilities!;
      for (const cls of OUTCOME_CLASSES) {
        const target = cls === sample.actual ? 1 : 0;
        brierSum += (probabilities[cls] - target) ** 2;
      }
      logSum += -Math.log(Math.min(1 - 1e-6, Math.max(1e-6, probabilities[sample.actual])));
    }
    brier = round(brierSum / withProbabilities.length);
    logLoss = round(logSum / withProbabilities.length);
  }

  return {
    n: samples.length,
    accuracy: samples.length ? round(correct / samples.length) : null,
    accuracyCi95: wilsonInterval(correct, samples.length),
    balancedAccuracy: recalls.length ? round(recalls.reduce((sum, value) => sum + value, 0) / recalls.length) : null,
    macroF1: (() => {
      const f1s = OUTCOME_CLASSES.map((cls) => perClass[cls].f1).filter((value): value is number => value != null);
      return f1s.length ? round(f1s.reduce((sum, value) => sum + value, 0) / f1s.length) : null;
    })(),
    actualDistribution: Object.fromEntries(OUTCOME_CLASSES.map((cls) => [cls, perClass[cls].support])) as Record<OutcomeClass, number>,
    predictedDistribution: Object.fromEntries(OUTCOME_CLASSES.map((cls) => [cls, perClass[cls].predicted])) as Record<OutcomeClass, number>,
    perClass,
    confusion,
    brier,
    logLoss
  };
}

export function evaluate(samples: EvaluatedSample[]): EvaluationReport {
  const independent = nonOverlapping(samples);
  const regimes = [...new Set(samples.map((sample) => sample.regime).filter((value): value is string => Boolean(value)))];
  return {
    all: classificationReport(samples),
    nonOverlapping: classificationReport(independent),
    baselines: {
      alwaysNeutral: classificationReport(independent.map((sample) => ({
        ...sample,
        predicted: 'NEUTRAL',
        probabilities: undefined
      })))
    },
    byRegime: Object.fromEntries(regimes.map((regime) => [
      regime,
      classificationReport(independent.filter((sample) => sample.regime === regime))
    ])),
    note: 'Overlapping return windows are not independent; use the non-overlapping figures for significance. Baselines are computed on the non-overlapping sample.'
  };
}

/**
 * Histogram-binning calibration on the directional score. Fit only on
 * chronologically earlier data; apply to later data. Laplace smoothing keeps
 * sparse bins from producing 0/1 probabilities.
 */
export interface ScoreCalibration {
  edges: number[];
  bins: Array<Record<OutcomeClass, number>>;
  trainedOn: number;
  trainedThrough: number;
}

export const DEFAULT_CALIBRATION_EDGES = [-100, -45, -25, -10, 10, 25, 45, 100.0001];

export function fitScoreCalibration(samples: EvaluatedSample[], edges = DEFAULT_CALIBRATION_EDGES): ScoreCalibration {
  const counts = edges.slice(0, -1).map(() => ({ UP: 1, NEUTRAL: 1, DOWN: 1 } as Record<OutcomeClass, number>));
  let trainedThrough = 0;
  for (const sample of samples) {
    if (sample.score == null) continue;
    const index = binIndex(sample.score, edges);
    counts[index][sample.actual] += 1;
    trainedThrough = Math.max(trainedThrough, sample.endAt);
  }
  const bins = counts.map((count) => {
    const total = count.UP + count.NEUTRAL + count.DOWN;
    return { UP: count.UP / total, NEUTRAL: count.NEUTRAL / total, DOWN: count.DOWN / total };
  });
  return { edges, bins, trainedOn: samples.filter((sample) => sample.score != null).length, trainedThrough };
}

function binIndex(score: number, edges: number[]) {
  const clamped = Math.max(edges[0], Math.min(edges[edges.length - 1] - 1e-9, score));
  for (let index = 0; index < edges.length - 1; index += 1) {
    if (clamped >= edges[index] && clamped < edges[index + 1]) return index;
  }
  return edges.length - 2;
}

export function applyScoreCalibration(calibration: ScoreCalibration, score: number): Record<OutcomeClass, number> {
  return { ...calibration.bins[binIndex(score, calibration.edges)] };
}

/**
 * Split chronologically by start time: earliest `trainFraction` for fitting.
 * Test samples whose window starts before the last training outcome is known
 * are purged, so no training label overlaps the test period.
 */
export function chronologicalSplit<T extends { startAt: number; endAt: number }>(samples: T[], trainFraction: number) {
  const sorted = [...samples].sort((left, right) => left.startAt - right.startAt);
  const cut = Math.floor(sorted.length * trainFraction);
  const train = sorted.slice(0, cut);
  const trainEnd = train.reduce((latest, sample) => Math.max(latest, sample.endAt), -Infinity);
  return { train, test: sorted.slice(cut).filter((sample) => sample.startAt >= trainEnd) };
}

/* ------------------------------------------------------------------ */
/* Probability quality                                                  */
/* ------------------------------------------------------------------ */

export type ProbabilityVector = Record<OutcomeClass, number>;

export interface ReliabilityBin {
  lower: number;
  upper: number;
  n: number;
  meanForecast: number;
  observedFrequency: number;
}

export interface ProbabilityReport {
  n: number;
  /**
   * Standard multiclass Brier score (Brier 1950): mean over observations of
   * the SUM over the 3 classes of (p_k - y_k)^2. Range 0 (perfect) to 2.
   * Lower is better. A uniform 1/3 forecast always scores 2/3 = 0.6667.
   */
  brier: number | null;
  /** Mean negative log-likelihood of the realised class (natural log). Uniform = ln 3 = 1.0986. */
  logLoss: number | null;
  /** Murphy decomposition summed over classes with 10 equal-width bins: brier ≈ reliability - resolution + uncertainty. */
  reliability: number | null;
  resolution: number | null;
  uncertainty: number | null;
  reliabilityBins: Record<OutcomeClass, ReliabilityBin[]>;
}

const BINS = 10;

export function brierScore(probabilities: ProbabilityVector, actual: OutcomeClass) {
  return OUTCOME_CLASSES.reduce((sum, cls) => sum + (probabilities[cls] - (cls === actual ? 1 : 0)) ** 2, 0);
}

export function logLossOf(probabilities: ProbabilityVector, actual: OutcomeClass) {
  return -Math.log(Math.min(1 - 1e-12, Math.max(1e-12, probabilities[actual])));
}

export function probabilityReport(items: Array<{ probabilities: ProbabilityVector; actual: OutcomeClass }>): ProbabilityReport {
  const n = items.length;
  const empty = Object.fromEntries(OUTCOME_CLASSES.map((cls) => [cls, []])) as unknown as Record<OutcomeClass, ReliabilityBin[]>;
  if (!n) return { n, brier: null, logLoss: null, reliability: null, resolution: null, uncertainty: null, reliabilityBins: empty };
  const brier = items.reduce((sum, item) => sum + brierScore(item.probabilities, item.actual), 0) / n;
  const logLoss = items.reduce((sum, item) => sum + logLossOf(item.probabilities, item.actual), 0) / n;
  let reliability = 0;
  let resolution = 0;
  let uncertainty = 0;
  const reliabilityBins = {} as Record<OutcomeClass, ReliabilityBin[]>;
  for (const cls of OUTCOME_CLASSES) {
    const base = items.filter((item) => item.actual === cls).length / n;
    uncertainty += base * (1 - base);
    const bins = Array.from({ length: BINS }, (_, index) => ({ lower: index / BINS, upper: (index + 1) / BINS, n: 0, sumP: 0, hits: 0 }));
    for (const item of items) {
      const p = Math.min(1, Math.max(0, item.probabilities[cls]));
      const bin = bins[Math.min(BINS - 1, Math.floor(p * BINS))];
      bin.n += 1;
      bin.sumP += p;
      if (item.actual === cls) bin.hits += 1;
    }
    reliabilityBins[cls] = bins.filter((bin) => bin.n > 0).map((bin) => ({
      lower: bin.lower,
      upper: bin.upper,
      n: bin.n,
      meanForecast: round(bin.sumP / bin.n),
      observedFrequency: round(bin.hits / bin.n)
    }));
    for (const bin of bins) {
      if (!bin.n) continue;
      reliability += (bin.n / n) * (bin.sumP / bin.n - bin.hits / bin.n) ** 2;
      resolution += (bin.n / n) * (bin.hits / bin.n - base) ** 2;
    }
  }
  return {
    n,
    brier: round(brier),
    logLoss: round(logLoss),
    reliability: round(reliability),
    resolution: round(resolution),
    uncertainty: round(uncertainty),
    reliabilityBins
  };
}

/** Skill score relative to a reference: 1 - score/reference (positive = better than reference). */
export function skillScore(score: number | null, reference: number | null) {
  if (score == null || reference == null || reference === 0) return null;
  return round(1 - score / reference);
}

/**
 * Discrimination of a continuous score for one class vs the rest (ROC AUC via
 * Mann-Whitney, ties count 0.5). 0.5 = no discrimination.
 */
export function rocAuc(scores: number[], positives: boolean[]) {
  const pairs = scores.map((score, index) => ({ score, positive: positives[index] })).sort((left, right) => left.score - right.score);
  const nPositive = pairs.filter((pair) => pair.positive).length;
  const nNegative = pairs.length - nPositive;
  if (!nPositive || !nNegative) return null;
  let rankSum = 0;
  for (let index = 0; index < pairs.length;) {
    let end = index;
    while (end + 1 < pairs.length && pairs[end + 1].score === pairs[index].score) end += 1;
    const averageRank = (index + end) / 2 + 1;
    for (let k = index; k <= end; k += 1) if (pairs[k].positive) rankSum += averageRank;
    index = end + 1;
  }
  return round((rankSum - (nPositive * (nPositive + 1)) / 2) / (nPositive * nNegative));
}

/* ------------------------------------------------------------------ */
/* Seeded bootstrap                                                     */
/* ------------------------------------------------------------------ */

/** Deterministic PRNG (mulberry32) so reported intervals are reproducible. */
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapInterval {
  estimate: number | null;
  low: number | null;
  high: number | null;
  iterations: number;
}

/**
 * Percentile bootstrap over observation indices. `statistic` receives the
 * resampled indices; pass the same indices to model and baseline for paired
 * differences. Use on non-overlapping samples only.
 */
export function bootstrap(n: number, statistic: (indices: number[]) => number | null, iterations = 1000, seed = 20261011): BootstrapInterval {
  const all = Array.from({ length: n }, (_, index) => index);
  const estimate = n ? statistic(all) : null;
  if (!n) return { estimate: null, low: null, high: null, iterations: 0 };
  const random = seededRandom(seed);
  const values: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const indices = Array.from({ length: n }, () => Math.floor(random() * n));
    const value = statistic(indices);
    if (value != null && Number.isFinite(value)) values.push(value);
  }
  values.sort((left, right) => left - right);
  const at = (q: number) => values.length ? round(values[Math.min(values.length - 1, Math.max(0, Math.floor(q * (values.length - 1))))]) : null;
  return { estimate: estimate == null ? null : round(estimate), low: at(0.025), high: at(0.975), iterations: values.length };
}
