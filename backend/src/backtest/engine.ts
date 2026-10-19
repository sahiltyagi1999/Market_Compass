import {
  applyScoreCalibration,
  bootstrap,
  brierScore,
  classificationReport,
  fitScoreCalibration,
  logLossOf,
  nonOverlapping,
  probabilityReport,
  rocAuc,
  skillScore,
  type BootstrapInterval,
  type ClassificationReport,
  type EvaluatedSample,
  type ProbabilityReport,
  type ProbabilityVector
} from '../evaluation.js';
import { DEFAULT_CONFIG, type ModelConfig } from '../modelConfig.js';
import { classifyOutcome, OUTCOME_CLASSES, type OutcomeClass, type PredictedClass } from '../outcomes.js';
import { scoreCrypto, scoreNifty, verdictFromScore } from '../scoring.js';
import type { CryptoSnapshot, MarketCard, NiftySnapshot } from '../types.js';
import { extractFeatures, FEATURES } from './features.js';
import { argmaxClass, fitLogistic, predictLogistic, type LogisticModel } from './logistic.js';
import { benchmarks, simulateStrategy, type StrategyWindow, type TradingStats } from './trading.js';

export interface Observation {
  /** Decision time (epoch ms): every input was knowable at this instant. */
  at: number;
  /** End of the outcome window. */
  targetAt: number;
  snapshot: NiftySnapshot | CryptoSnapshot;
  startPrice: number;
  endPrice: number;
  /** Momentum baseline input: underlying return over the previous window, %. */
  priorReturnPct?: number;
}

/** Observation scored once by the production (hand-set) model. Labels are derived per threshold. */
export interface Prepared {
  observation: Observation;
  startAt: number;
  endAt: number;
  returnPct: number;
  score: number;
  heuristic: ProbabilityVector;
  features: Array<number | undefined>;
  regime?: string;
}

export interface BacktestOptions {
  market: MarketCard['slug'];
  config?: ModelConfig;
  /** Final untouched test share (chronologically last). */
  testFraction?: number;
  /** Walk-forward blocks inside the development period (folds = blocks - 1). */
  developmentBlocks?: number;
  /** Symmetric outcome thresholds (%) compared on development data only. */
  outcomeThresholds?: number[];
  verdictThresholds?: number[];
  lambdas?: number[];
  logisticIterations?: number;
  roundTripCostPct?: number;
  bootstrapIterations?: number;
  ablationGroups?: Record<string, string[]>;
}

export const MODEL_NAMES = ['handSet', 'logistic'] as const;
export const CLASSIFICATION_BASELINES = ['majority', 'alwaysNeutral', 'momentum'] as const;
export const PROBABILITY_MODELS = ['heuristic', 'scoreCalibrated', 'logistic', 'uniform', 'empirical'] as const;

type ClassifierName = typeof MODEL_NAMES[number] | typeof CLASSIFICATION_BASELINES[number];
type ProbabilityName = typeof PROBABILITY_MODELS[number];

export interface FittedModels {
  outcomeThreshold: number;
  verdictThreshold: number;
  logistic: LogisticModel;
  calibrationTrainedOn: number;
  trainFrequencies: ProbabilityVector;
  majorityClass: OutcomeClass;
  trainRange: { from: string | null; to: string | null; n: number };
  apply: {
    calibrated: (score: number) => ProbabilityVector;
  };
}

export interface EvaluationBlock {
  range: { from: string | null; to: string | null };
  /** Non-overlapping windows actually scored. */
  n: number;
  classification: Record<ClassifierName, ClassificationReport>;
  /** Share of windows where the classifier made no directional call. */
  abstentionRate: Record<ClassifierName, number | null>;
  probability: Record<ProbabilityName, ProbabilityReport>;
  /** Brier skill vs the empirical (training class-frequency) forecast; > 0 means better. */
  brierSkillVsEmpirical: Record<ProbabilityName, number | null>;
  logLossSkillVsEmpirical: Record<ProbabilityName, number | null>;
  /** One-vs-rest ROC AUC: discrimination independent of calibration. */
  discrimination: {
    handSetScore: { up: number | null; down: number | null };
    logistic: { up: number | null; down: number | null };
  };
  intervals?: {
    macroF1: Record<ClassifierName, BootstrapInterval>;
    balancedAccuracy: Record<ClassifierName, BootstrapInterval>;
    /** Paired differences on identical resamples: model minus baseline. */
    macroF1Lift: Record<string, BootstrapInterval>;
    brierDifferenceVsEmpirical: Record<string, BootstrapInterval>;
  };
  trading?: {
    rules: string;
    strategies: Record<'handSet' | 'logistic' | 'momentum', TradingStats>;
    benchmarks: ReturnType<typeof benchmarks>;
    /** Hand-set net compounded return (%) and max drawdown at alternative round-trip costs. */
    costSensitivity: Array<{ costPct: number; handSetNetPct: number; handSetMaxDrawdownPct: number; momentumNetPct: number }>;
  };
}

const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const iso = (time?: number) => time == null ? null : new Date(time).toISOString();

export function labelOf(sample: Pick<Prepared, 'returnPct'>, threshold: number): OutcomeClass {
  return classifyOutcome(sample.returnPct, { upPct: threshold, downPct: threshold });
}

export function momentumCall(prior: number | undefined, threshold: number): PredictedClass {
  if (prior == null) return 'NEUTRAL';
  if (prior > threshold) return 'BULLISH';
  if (prior < -threshold) return 'BEARISH';
  return 'NEUTRAL';
}

const toPredicted = (cls: OutcomeClass): PredictedClass => cls === 'UP' ? 'BULLISH' : cls === 'DOWN' ? 'BEARISH' : 'NEUTRAL';

export function prepare(observations: Observation[], market: MarketCard['slug'], config: ModelConfig) {
  const prepared: Prepared[] = [];
  let unavailable = 0;
  for (const observation of observations) {
    const sources = [{ name: 'replay', status: 'live' as const, message: 'historical' }];
    const card = market === 'nifty'
      ? scoreNifty(observation.snapshot as NiftySnapshot, sources, { config, now: observation.at })
      : scoreCrypto(observation.snapshot as CryptoSnapshot, sources, { config, now: observation.at });
    // UNAVAILABLE never trades and is never scored as a prediction.
    if (card.verdict === 'UNAVAILABLE') {
      unavailable += 1;
      continue;
    }
    prepared.push({
      observation,
      startAt: observation.at,
      endAt: observation.targetAt,
      returnPct: ((observation.endPrice - observation.startPrice) / observation.startPrice) * 100,
      score: card.score,
      heuristic: { UP: card.probabilities.bullish / 100, NEUTRAL: card.probabilities.neutral / 100, DOWN: card.probabilities.bearish / 100 },
      features: extractFeatures(market, observation.snapshot),
      regime: card.evidence.find((item) => item.key === 'regime')?.value.split(' ')[0]
    });
  }
  prepared.sort((left, right) => left.startAt - right.startAt);
  return { prepared, unavailable };
}

/**
 * Final test = chronologically last `testFraction`. Development samples whose
 * outcome window ends after the test starts are purged.
 */
export function developmentTestSplit<T extends { startAt: number; endAt: number }>(samples: T[], testFraction: number) {
  const sorted = [...samples].sort((left, right) => left.startAt - right.startAt);
  const cut = Math.floor(sorted.length * (1 - testFraction));
  const testStart = sorted[cut]?.startAt ?? Infinity;
  const development = sorted.slice(0, cut).filter((sample) => sample.endAt <= testStart);
  return { development, test: sorted.slice(cut), purged: cut - development.length };
}

/** Expanding-window folds inside development: train on blocks < i (purged), evaluate on block i. */
export function walkForwardFolds<T extends { startAt: number; endAt: number }>(development: T[], blocks: number) {
  const size = Math.floor(development.length / blocks);
  const folds: Array<{ train: T[]; evaluation: T[] }> = [];
  for (let block = 1; block < blocks; block += 1) {
    const start = development[block * size]?.startAt;
    if (start == null) break;
    const end = block === blocks - 1 ? Infinity : development[(block + 1) * size]?.startAt ?? Infinity;
    folds.push({
      train: development.filter((sample) => sample.endAt <= start),
      evaluation: development.filter((sample) => sample.startAt >= start && sample.startAt < end)
    });
  }
  return folds;
}

function evaluated(samples: Prepared[], threshold: number, predicted: (sample: Prepared, index: number) => PredictedClass): EvaluatedSample[] {
  return samples.map((sample, index) => ({
    startAt: sample.startAt,
    endAt: sample.endAt,
    predicted: predicted(sample, index),
    actual: labelOf(sample, threshold),
    score: sample.score,
    returnPct: sample.returnPct,
    regime: sample.regime
  }));
}

/** Fits everything that is learned (verdict threshold, logistic weights, calibration, base rates) on training rows only. */
export function fitModels(train: Prepared[], outcomeThreshold: number, options: Required<Pick<BacktestOptions, 'market' | 'verdictThresholds' | 'lambdas' | 'logisticIterations'>>): FittedModels {
  const labels = train.map((sample) => labelOf(sample, outcomeThreshold));
  const counts = { UP: 1, NEUTRAL: 1, DOWN: 1 } as Record<OutcomeClass, number>;
  for (const label of labels) counts[label] += 1;
  const total = counts.UP + counts.NEUTRAL + counts.DOWN;
  const trainFrequencies = { UP: counts.UP / total, NEUTRAL: counts.NEUTRAL / total, DOWN: counts.DOWN / total };
  const majorityClass = OUTCOME_CLASSES.reduce((best, cls) => counts[cls] > counts[best] ? cls : best, OUTCOME_CLASSES[0]);

  // Verdict threshold: best balanced accuracy on training rows; ties prefer the pre-registered default.
  const verdictThreshold = options.verdictThresholds
    .map((threshold) => ({ threshold, value: classificationReport(evaluated(train, outcomeThreshold, (sample) => verdictFromScore(sample.score, threshold))).balancedAccuracy ?? -1 }))
    .sort((left, right) => right.value - left.value || Math.abs(left.threshold - DEFAULT_CONFIG.verdictThreshold) - Math.abs(right.threshold - DEFAULT_CONFIG.verdictThreshold))[0]?.threshold ?? DEFAULT_CONFIG.verdictThreshold;

  // Logistic penalty: inner chronological split of the training rows (purged), scored by log loss.
  const names = FEATURES[options.market];
  const inner = developmentTestSplit(train, 0.25);
  const innerValidation = nonOverlapping(inner.test);
  const lambda = options.lambdas.length === 1 || !inner.development.length || !innerValidation.length
    ? options.lambdas[0]
    : options.lambdas
      .map((candidate) => {
        const model = fitLogistic(names, inner.development.map((sample) => sample.features), inner.development.map((sample) => labelOf(sample, outcomeThreshold)), { lambda: candidate, iterations: options.logisticIterations });
        const loss = innerValidation.reduce((sum, sample) => sum + logLossOf(predictLogistic(model, sample.features), labelOf(sample, outcomeThreshold)), 0) / innerValidation.length;
        return { candidate, loss };
      })
      .sort((left, right) => left.loss - right.loss)[0].candidate;
  const logistic = fitLogistic(names, train.map((sample) => sample.features), labels, { lambda, iterations: options.logisticIterations });

  const calibrationRows = nonOverlapping(evaluated(train, outcomeThreshold, () => 'NEUTRAL'));
  const calibration = fitScoreCalibration(calibrationRows);
  return {
    outcomeThreshold,
    verdictThreshold,
    logistic,
    calibrationTrainedOn: calibration.trainedOn,
    trainFrequencies,
    majorityClass,
    trainRange: { from: iso(train[0]?.startAt), to: iso(train[train.length - 1]?.endAt), n: train.length },
    apply: { calibrated: (score) => applyScoreCalibration(calibration, score) }
  };
}

export function evaluateBlock(
  models: FittedModels,
  samples: Prepared[],
  options: { costPct?: number; bootstrapIterations?: number }
): EvaluationBlock {
  const windows = nonOverlapping(samples);
  const threshold = models.outcomeThreshold;
  const actual = windows.map((sample) => labelOf(sample, threshold));
  const logisticProbabilities = windows.map((sample) => predictLogistic(models.logistic, sample.features));
  const predictions: Record<ClassifierName, PredictedClass[]> = {
    handSet: windows.map((sample) => verdictFromScore(sample.score, models.verdictThreshold)),
    logistic: logisticProbabilities.map((probabilities) => toPredicted(argmaxClass(probabilities))),
    majority: windows.map(() => toPredicted(models.majorityClass)),
    alwaysNeutral: windows.map(() => 'NEUTRAL'),
    momentum: windows.map((sample) => momentumCall(sample.observation.priorReturnPct, threshold))
  };
  const probabilities: Record<ProbabilityName, ProbabilityVector[]> = {
    heuristic: windows.map((sample) => sample.heuristic),
    scoreCalibrated: windows.map((sample) => models.apply.calibrated(sample.score)),
    logistic: logisticProbabilities,
    uniform: windows.map(() => ({ UP: 1 / 3, NEUTRAL: 1 / 3, DOWN: 1 / 3 })),
    empirical: windows.map(() => models.trainFrequencies)
  };
  const asSamples = (name: ClassifierName, indices?: number[]): EvaluatedSample[] => (indices ?? windows.map((_, index) => index)).map((index) => ({
    startAt: windows[index].startAt,
    endAt: windows[index].endAt,
    predicted: predictions[name][index],
    actual: actual[index]
  }));
  const classifiers = [...MODEL_NAMES, ...CLASSIFICATION_BASELINES];
  const classification = Object.fromEntries(classifiers.map((name) => [name, classificationReport(asSamples(name))])) as Record<ClassifierName, ClassificationReport>;
  const probability = Object.fromEntries(PROBABILITY_MODELS.map((name) => [name, probabilityReport(probabilities[name].map((vector, index) => ({ probabilities: vector, actual: actual[index] })))])) as Record<ProbabilityName, ProbabilityReport>;
  const block: EvaluationBlock = {
    range: { from: iso(windows[0]?.startAt), to: iso(windows[windows.length - 1]?.endAt) },
    n: windows.length,
    classification,
    abstentionRate: Object.fromEntries(classifiers.map((name) => [name, windows.length ? round(predictions[name].filter((value) => value === 'NEUTRAL').length / windows.length) : null])) as Record<ClassifierName, number | null>,
    probability,
    brierSkillVsEmpirical: Object.fromEntries(PROBABILITY_MODELS.map((name) => [name, skillScore(probability[name].brier, probability.empirical.brier)])) as Record<ProbabilityName, number | null>,
    logLossSkillVsEmpirical: Object.fromEntries(PROBABILITY_MODELS.map((name) => [name, skillScore(probability[name].logLoss, probability.empirical.logLoss)])) as Record<ProbabilityName, number | null>,
    discrimination: {
      handSetScore: {
        up: rocAuc(windows.map((sample) => sample.score), actual.map((label) => label === 'UP')),
        down: rocAuc(windows.map((sample) => -sample.score), actual.map((label) => label === 'DOWN'))
      },
      logistic: {
        up: rocAuc(logisticProbabilities.map((vector) => vector.UP), actual.map((label) => label === 'UP')),
        down: rocAuc(logisticProbabilities.map((vector) => vector.DOWN), actual.map((label) => label === 'DOWN'))
      }
    }
  };

  if (options.bootstrapIterations) {
    const iterations = options.bootstrapIterations;
    const metricOf = (name: ClassifierName, key: 'macroF1' | 'balancedAccuracy') => (indices: number[]) => classificationReport(asSamples(name, indices))[key];
    const brierOf = (name: ProbabilityName, indices: number[]) => indices.reduce((sum, index) => sum + brierScore(probabilities[name][index], actual[index]), 0) / indices.length;
    const lifts: Record<string, BootstrapInterval> = {};
    for (const model of MODEL_NAMES) {
      for (const baseline of CLASSIFICATION_BASELINES) {
        lifts[`${model}-${baseline}`] = bootstrap(windows.length, (indices) => {
          const left = metricOf(model, 'macroF1')(indices);
          const right = metricOf(baseline, 'macroF1')(indices);
          return left == null || right == null ? null : left - right;
        }, iterations);
      }
    }
    block.intervals = {
      macroF1: Object.fromEntries(classifiers.map((name) => [name, bootstrap(windows.length, metricOf(name, 'macroF1'), iterations)])) as Record<ClassifierName, BootstrapInterval>,
      balancedAccuracy: Object.fromEntries(classifiers.map((name) => [name, bootstrap(windows.length, metricOf(name, 'balancedAccuracy'), iterations)])) as Record<ClassifierName, BootstrapInterval>,
      macroF1Lift: lifts,
      brierDifferenceVsEmpirical: Object.fromEntries((['heuristic', 'scoreCalibrated', 'logistic', 'uniform'] as const).map((name) => [
        name,
        bootstrap(windows.length, (indices) => brierOf(name, indices) - brierOf('empirical', indices), iterations)
      ]))
    };
  }

  if (options.costPct != null) {
    const strategy = (name: 'handSet' | 'logistic' | 'momentum'): StrategyWindow[] => windows.map((sample, index) => ({
      startAt: sample.startAt,
      endAt: sample.endAt,
      returnPct: sample.returnPct,
      predicted: predictions[name][index]
    }));
    const plain = strategy('handSet');
    block.trading = {
      rules: 'One decision per non-overlapping window; BULLISH long, BEARISH short, NEUTRAL flat; entry at decision close, exit at target close; 100% equity, compounded; flat round-trip cost.',
      strategies: {
        handSet: simulateStrategy(plain, options.costPct),
        logistic: simulateStrategy(strategy('logistic'), options.costPct),
        momentum: simulateStrategy(strategy('momentum'), options.costPct)
      },
      benchmarks: benchmarks(plain, windows[0]?.observation.startPrice, windows[windows.length - 1]?.observation.endPrice, options.costPct),
      costSensitivity: [0, 0.05, 0.1, 0.2, 0.3].map((costPct) => {
        const hand = simulateStrategy(plain, costPct);
        return { costPct, handSetNetPct: hand.compoundedReturnPct, handSetMaxDrawdownPct: hand.maxDrawdownPct, momentumNetPct: simulateStrategy(strategy('momentum'), costPct).compoundedReturnPct };
      })
    };
  }
  return block;
}

export interface ThresholdSensitivityRow {
  outcomeThreshold: number;
  developmentDistribution: Record<OutcomeClass, number>;
  folds: Array<{
    trainRange: FittedModels['trainRange'];
    evaluationRange: EvaluationBlock['range'];
    n: number;
    actualDistribution: Record<OutcomeClass, number>;
    verdictThreshold: number;
    lambda: number;
    macroF1: Record<ClassifierName, number | null>;
    balancedAccuracy: Record<ClassifierName, number | null>;
    abstentionRate: Record<ClassifierName, number | null>;
    brierSkillVsEmpirical: Record<ProbabilityName, number | null>;
    /** Hand-set strategy on this fold's windows (compounded %, gross and after the default cost). */
    handSetTrading: { trades: number; grossPct: number; netPct: number };
  }>;
  summary: {
    meanMacroF1: Record<ClassifierName, number | null>;
    /** Mean over folds of (model macro-F1 - best baseline macro-F1 in that fold). */
    meanLiftOverBestBaseline: Record<'handSet' | 'logistic', number | null>;
    foldsWithPositiveLift: Record<'handSet' | 'logistic', number>;
    meanBrierSkillVsEmpirical: Record<ProbabilityName, number | null>;
  };
}

export interface BacktestReport {
  market: MarketCard['slug'];
  modelVersion: string;
  definitions: Record<string, string>;
  settings: Required<Omit<BacktestOptions, 'config' | 'ablationGroups'>> & { horizonMinutes: number; defaultOutcomeThreshold: number };
  dataset: {
    observations: number;
    excludedUnavailable: number;
    usable: number;
    development: { n: number; from: string | null; to: string | null };
    test: { n: number; from: string | null; to: string | null };
    purgedAtTestBoundary: number;
  };
  thresholdSensitivity: ThresholdSensitivityRow[];
  selection: {
    rule: string;
    selectedOutcomeThreshold: number;
    selectedByDevelopmentOnly: true;
    persistentImprovement: Record<'handSet' | 'logistic', boolean>;
  };
  finalTest: Array<{
    label: string;
    outcomeThreshold: number;
    fitted: Omit<FittedModels, 'apply' | 'logistic'> & {
      lambda: number;
      logisticTrainedOn: number;
      /** Standardised coefficients per class (feature -> weight); larger |w| = stronger influence. */
      logisticCoefficients: Record<OutcomeClass, Record<string, number>>;
    };
    result: EvaluationBlock;
  }>;
  ablation: Array<{ removed: string; macroF1: number | null; deltaVsFull: number | null }>;
  limitations: string[];
}

function mean(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value != null);
  return valid.length ? round(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null;
}

export function runBacktest(observations: Observation[], options: BacktestOptions): BacktestReport {
  const config = options.config ?? DEFAULT_CONFIG;
  const settings = {
    market: options.market,
    testFraction: options.testFraction ?? 0.2,
    developmentBlocks: options.developmentBlocks ?? 5,
    outcomeThresholds: options.outcomeThresholds ?? (options.market === 'crypto' ? [0.1, 0.2, 0.3, 0.5, 0.75, 1] : [0.1, 0.2, 0.3, 0.5]),
    verdictThresholds: options.verdictThresholds ?? [10, 15, 20, 25, 30, 35, 40, 50],
    lambdas: options.lambdas ?? [0.001, 0.01, 0.1, 1],
    logisticIterations: options.logisticIterations ?? 300,
    roundTripCostPct: options.roundTripCostPct ?? (options.market === 'crypto' ? 0.2 : 0.05),
    bootstrapIterations: options.bootstrapIterations ?? 1000,
    horizonMinutes: config.horizonMinutes[options.market],
    defaultOutcomeThreshold: config.outcome[options.market].upPct
  };
  const fitOptions = { market: settings.market, verdictThresholds: settings.verdictThresholds, lambdas: settings.lambdas, logisticIterations: settings.logisticIterations };
  const { prepared, unavailable } = prepare(observations, options.market, config);
  const { development, test, purged } = developmentTestSplit(prepared, settings.testFraction);
  const folds = walkForwardFolds(development, settings.developmentBlocks);

  // 1) Threshold sensitivity and model comparison on development data only.
  const sensitivity: ThresholdSensitivityRow[] = settings.outcomeThresholds.map((outcomeThreshold) => {
    const distribution = { UP: 0, NEUTRAL: 0, DOWN: 0 } as Record<OutcomeClass, number>;
    for (const sample of development) distribution[labelOf(sample, outcomeThreshold)] += 1;
    const foldRows = folds.map((fold) => {
      const models = fitModels(fold.train, outcomeThreshold, fitOptions);
      const block = evaluateBlock(models, fold.evaluation, { costPct: settings.roundTripCostPct });
      const pick = <K extends 'macroF1' | 'balancedAccuracy'>(key: K) => Object.fromEntries(Object.entries(block.classification).map(([name, report]) => [name, report[key]])) as Record<ClassifierName, number | null>;
      return {
        trainRange: models.trainRange,
        evaluationRange: block.range,
        n: block.n,
        actualDistribution: block.classification.handSet.actualDistribution,
        verdictThreshold: models.verdictThreshold,
        lambda: models.logistic.lambda,
        macroF1: pick('macroF1'),
        balancedAccuracy: pick('balancedAccuracy'),
        abstentionRate: block.abstentionRate,
        brierSkillVsEmpirical: block.brierSkillVsEmpirical,
        handSetTrading: {
          trades: block.trading!.strategies.handSet.trades,
          grossPct: block.trading!.strategies.handSet.grossCompoundedReturnPct,
          netPct: block.trading!.strategies.handSet.compoundedReturnPct
        }
      };
    });
    const liftOf = (model: 'handSet' | 'logistic') => foldRows.map((row) => {
      const best = Math.max(...CLASSIFICATION_BASELINES.map((name) => row.macroF1[name] ?? -1));
      return row.macroF1[model] == null ? null : row.macroF1[model]! - best;
    });
    const classifierNames = [...MODEL_NAMES, ...CLASSIFICATION_BASELINES];
    return {
      outcomeThreshold,
      developmentDistribution: distribution,
      folds: foldRows,
      summary: {
        meanMacroF1: Object.fromEntries(classifierNames.map((name) => [name, mean(foldRows.map((row) => row.macroF1[name]))])) as Record<ClassifierName, number | null>,
        meanLiftOverBestBaseline: { handSet: mean(liftOf('handSet')), logistic: mean(liftOf('logistic')) },
        foldsWithPositiveLift: {
          handSet: liftOf('handSet').filter((value) => value != null && value > 0).length,
          logistic: liftOf('logistic').filter((value) => value != null && value > 0).length
        },
        meanBrierSkillVsEmpirical: Object.fromEntries(PROBABILITY_MODELS.map((name) => [name, mean(foldRows.map((row) => row.brierSkillVsEmpirical[name]))])) as Record<ProbabilityName, number | null>
      }
    };
  });

  // 2) Pick the outcome threshold from development folds only; the test set has not been touched.
  const selected = [...sensitivity].sort((left, right) => (right.summary.meanLiftOverBestBaseline.handSet ?? -Infinity) - (left.summary.meanLiftOverBestBaseline.handSet ?? -Infinity))[0];
  const selectedThreshold = selected?.outcomeThreshold ?? settings.defaultOutcomeThreshold;
  const persistent = (model: 'handSet' | 'logistic') => Boolean(selected
    && (selected.summary.meanLiftOverBestBaseline[model] ?? 0) > 0
    && selected.summary.foldsWithPositiveLift[model] >= Math.ceil(folds.length * 0.75));

  // 3) Final evaluation: refit on all development data, score the untouched test once per reported threshold.
  const finalThresholds = [...new Set([settings.defaultOutcomeThreshold, selectedThreshold])];
  const finalTest = finalThresholds.map((outcomeThreshold) => {
    const models = fitModels(development, outcomeThreshold, fitOptions);
    const result = evaluateBlock(models, test, { costPct: settings.roundTripCostPct, bootstrapIterations: settings.bootstrapIterations });
    const { apply: _apply, logistic, ...fitted } = models;
    void _apply;
    return {
      label: outcomeThreshold === settings.defaultOutcomeThreshold && outcomeThreshold === selectedThreshold
        ? 'pre-registered default (also selected on development)'
        : outcomeThreshold === settings.defaultOutcomeThreshold ? 'pre-registered default' : 'selected on development folds',
      outcomeThreshold,
      fitted: {
        ...fitted,
        lambda: logistic.lambda,
        logisticTrainedOn: logistic.trainedOn,
        logisticCoefficients: Object.fromEntries(OUTCOME_CLASSES.map((cls, index) => [
          cls,
          Object.fromEntries(logistic.featureNames.map((name, j) => [name, round(logistic.weights[index][j + 1])]))
        ])) as Record<OutcomeClass, Record<string, number>>
      },
      result
    };
  });

  // 4) Ablation on the last development fold (never on test).
  const lastFold = folds[folds.length - 1];
  const ablation: BacktestReport['ablation'] = [];
  if (lastFold && options.ablationGroups) {
    const base = fitModels(lastFold.train, selectedThreshold, { ...fitOptions, lambdas: [settings.lambdas[0]], logisticIterations: 1 });
    const full = evaluateBlock(base, lastFold.evaluation, {}).classification.handSet.macroF1;
    for (const [name, keys] of Object.entries(options.ablationGroups)) {
      const ablatedConfig: ModelConfig = { ...config, disabledFeatures: [...config.disabledFeatures, ...keys] };
      const rescored = prepare(lastFold.evaluation.map((sample) => sample.observation), options.market, ablatedConfig).prepared;
      const value = evaluateBlock(base, rescored, {}).classification.handSet.macroF1;
      ablation.push({ removed: name, macroF1: value, deltaVsFull: value != null && full != null ? round(value - full) : null });
    }
  }

  return {
    market: options.market,
    modelVersion: config.version,
    definitions: {
      outcome: 'UP if window return > +t%, DOWN if < -t%, else NEUTRAL (t = outcome threshold).',
      evaluationSample: 'Greedy chronological non-overlapping windows; every model and baseline is scored on exactly the same windows and labels.',
      handSet: 'Production scoring formula; verdict threshold (±score) chosen on training rows by balanced accuracy.',
      logistic: 'Experimental multinomial L2 logistic regression on raw replay features; scaling/imputation/penalty fitted on training rows (penalty via an inner purged chronological split).',
      majority: 'Always predicts the most frequent class in the training rows.',
      alwaysNeutral: 'Always predicts NEUTRAL.',
      momentum: 'Predicts the sign of the previous window return when it exceeds ±t%, else NEUTRAL.',
      uniform: 'Probability 1/3 for each class.',
      empirical: 'Training-period class frequencies (Laplace-smoothed) for every window.',
      heuristic: 'Production uncalibrated bull/neutral/bear split.',
      scoreCalibrated: 'Score-bin class frequencies fitted on non-overlapping training windows.',
      brier: 'Standard multiclass Brier score: mean of the sum over 3 classes of (p - y)^2; range 0-2, lower is better; uniform forecast = 0.6667.',
      logLoss: 'Mean negative natural log of the probability given to the realised class; uniform = ln 3 = 1.0986.',
      skill: 'Skill = 1 - score / empirical-baseline score; > 0 means better than the training class frequencies.',
      macroF1: 'Unweighted mean of per-class F1 over classes that occur.',
      intervals: 'Seeded percentile bootstrap (resampling non-overlapping test windows); paired differences reuse identical resamples.'
    },
    settings,
    dataset: {
      observations: observations.length,
      excludedUnavailable: unavailable,
      usable: prepared.length,
      development: { n: development.length, from: iso(development[0]?.startAt), to: iso(development[development.length - 1]?.endAt) },
      test: { n: test.length, from: iso(test[0]?.startAt), to: iso(test[test.length - 1]?.endAt) },
      purgedAtTestBoundary: purged
    },
    thresholdSensitivity: sensitivity,
    selection: {
      rule: 'Outcome threshold with the highest mean (over walk-forward development folds) hand-set macro-F1 lift over the best classification baseline. A model is called persistently better only if its mean lift > 0 and it beats the best baseline in at least 75% of folds.',
      selectedOutcomeThreshold: selectedThreshold,
      selectedByDevelopmentOnly: true,
      persistentImprovement: { handSet: persistent('handSet'), logistic: persistent('logistic') }
    },
    finalTest,
    ablation,
    limitations: []
  };
}
