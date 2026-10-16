import { researchDecision } from './decision.js';
import { intradayTarget, marketStatus } from './marketSession.js';
import { DEFAULT_CONFIG, type ModelConfig } from './modelConfig.js';
import type {
  AnalystSignal,
  CalibrationStatus,
  CryptoSnapshot,
  DirectionProbabilities,
  EvidenceItem,
  EvidenceRole,
  MarketCard,
  Metric,
  NiftySnapshot,
  SessionInfo,
  SignalQuality,
  SourceStatus,
  Tone,
  TrackRecord,
  Verdict
} from './types.js';

type AnalystKey = AnalystSignal['key'];
type MarketSlug = MarketCard['slug'];

export interface ScoreOptions {
  config?: ModelConfig;
  now?: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Normalise a signed value into [-1, 1], where |value| >= range is a
 * full-strength signal. Returns undefined (missing, NOT neutral) for missing,
 * non-finite values or a non-positive range.
 */
export function scaled(value: number | null | undefined, range: number): number | undefined {
  if (!isNumber(value) || !isNumber(range) || range <= 0) return undefined;
  return clamp(value / range, -1, 1);
}

export function percentChange(current: number | undefined, previous: number | undefined) {
  if (!isNumber(current) || !isNumber(previous) || previous <= 0) return undefined;
  return ((current - previous) / previous) * 100;
}

export function emptyTrackRecord(minimumSample = 30): TrackRecord {
  return {
    resolved: 0,
    pending: 0,
    unresolvable: 0,
    hitRate: null,
    nonOverlapping: { n: 0, hitRate: null, ci95: null, alwaysNeutralHitRate: null, majorityClassHitRate: null, balancedAccuracy: null },
    minimumSample,
    note: 'Collecting forward outcomes; no resolved sample yet.'
  };
}

export function insufficientCalibration(sampleSize = 0, required = 150): CalibrationStatus {
  return {
    status: 'insufficient_data',
    method: 'Score-bin frequencies fitted on chronologically earlier outcomes',
    sampleSize,
    required,
    calibratedProbabilities: null,
    brier: null,
    logLoss: null,
    heuristicBrier: null,
    empiricalBrier: null,
    note: `Calibrated probability is unavailable until ${required} resolved non-overlapping predictions exist (${sampleSize}/${required}).`
  };
}

function toneFromSigned(value: number, positiveIsGood = true): Tone {
  if (Math.abs(value) < 0.01) return 'neutral';
  if (positiveIsGood) return value > 0 ? 'positive' : 'negative';
  return value > 0 ? 'negative' : 'positive';
}

function metric(label: string, value: string, note: string, tone: Tone): Metric {
  return { label, value, note, tone };
}

interface Feature {
  key: string;
  label: string;
  value: string;
  reason: string;
  role: EvidenceRole;
  analyst?: AnalystKey;
  /** Normalised [-1, 1] value for direction/risk features. */
  normalized?: number;
}

function feature(
  role: EvidenceRole,
  analyst: AnalystKey | undefined,
  key: string,
  label: string,
  value: string,
  normalized: number | undefined,
  reason: string
): Feature {
  return { key, label, value, normalized, reason, role, analyst };
}

function context(key: string, label: string, value: string, reason: string): Feature {
  return { key, label, value, reason, role: 'context' };
}

interface AnalystSpec {
  key: AnalystKey;
  name: string;
  summary: (score: number | undefined, inputs: number) => string;
  /** Replaces the base + perInput confidence rule (used for news sentiment). */
  confidence?: number;
}

function stance(score: number, threshold: number): AnalystSignal['stance'] {
  if (score >= threshold) return 'BULLISH';
  if (score <= -threshold) return 'BEARISH';
  return 'NEUTRAL';
}

export function verdictFromScore(score: number, threshold = DEFAULT_CONFIG.verdictThreshold): Exclude<Verdict, 'UNAVAILABLE'> {
  if (score >= threshold) return 'BULLISH';
  if (score <= -threshold) return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * Heuristic display distribution. It is NOT a calibrated probability: it is a
 * deterministic transform of score and signal quality, always sums to 100 and
 * never goes negative.
 */
export function heuristicProbabilities(score: number, confidence: number, unavailable: boolean): DirectionProbabilities {
  if (unavailable || !isNumber(score) || !isNumber(confidence)) return { bullish: 0, neutral: 100, bearish: 0 };
  const neutral = Math.round(clamp(52 - Math.abs(score) * 0.7 + (100 - confidence) * 0.12, 10, 82));
  const directional = 100 - neutral;
  const bullishShare = 1 / (1 + Math.exp(-score / 16));
  const bullish = Math.round(directional * bullishShare);
  return { bullish, neutral, bearish: 100 - neutral - bullish };
}

/**
 * Signal quality (uncalibrated): 28 + coverage*42 + agreement*15 +
 * |score|*0.12 + riskAdjustment, clamped to [28, 89]. Describes how much and
 * how consistent the evidence is; it is not a probability of being right.
 */
export function signalQuality(input: {
  coverage: number;
  agreement: number;
  score: number;
  riskAdjustment: number;
}): number {
  const raw = 28 + clamp(input.coverage, 0, 1) * 42 + clamp(input.agreement, 0, 1) * 15
    + Math.abs(clamp(input.score, -100, 100)) * 0.12 + input.riskAdjustment;
  return Math.round(clamp(isNumber(raw) ? raw : 28, 28, 89));
}

function availabilityFromSources(sources: SourceStatus[]) {
  const required = sources.filter((source) => !source.optional);
  const live = required.filter((source) => source.status === 'live').length;
  if (!live) return 'unavailable' as const;
  if (live === required.length) return 'live' as const;
  return 'partial' as const;
}

function istClock(time: number) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(time));
}

export function sessionInfo(slug: MarketSlug, now: number, config: ModelConfig): SessionInfo {
  if (slug === 'crypto') {
    const targetAt = now + config.horizonMinutes.crypto * 60_000;
    return {
      open: true,
      label: `Horizon to ${istClock(targetAt)} IST`,
      detail: `${config.horizonMinutes.crypto / 60}-hour window, evaluated in UTC against the 1-minute close at the target time`,
      targetAt: new Date(targetAt).toISOString()
    };
  }
  const status = marketStatus(now);
  if (!status.open) {
    const reason = status.state === 'holiday' ? `NSE holiday${status.holidayName ? ` (${status.holidayName})` : ''}` : status.state === 'weekend' ? 'Weekend' : status.state === 'pre-open' ? 'Before the 09:15 open' : 'After the 15:30 close';
    return {
      open: false,
      label: 'Market closed',
      detail: `${reason}; next session opens ${status.nextOpenAt ? `${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short' }).format(new Date(status.nextOpenAt))} 09:15 IST` : 'at the next trading day'}`,
      targetAt: null
    };
  }
  const target = intradayTarget(now, config.horizonMinutes.nifty, config.minIntradayHorizonMinutes);
  if (!target.ok) {
    return {
      open: true,
      label: 'No new forecast window',
      detail: target.detail,
      targetAt: null
    };
  }
  return {
    open: true,
    label: `Horizon to ${istClock(target.targetAt)} IST`,
    detail: target.truncatedAtClose
      ? `Capped at today's 15:30 close (${target.horizonMinutes} min); never rolls into the next session`
      : `${target.horizonMinutes} minutes, intraday only`,
    targetAt: new Date(target.targetAt).toISOString()
  };
}

function buildCases(items: EvidenceItem[]) {
  const directional = items.filter((item) => item.role === 'direction');
  const bullCase = directional
    .filter((item) => item.contribution > 1)
    .sort((left, right) => right.contribution - left.contribution)
    .slice(0, 3)
    .map((item) => `${item.label} (${item.value}) adds ${item.contribution.toFixed(1)} points.`);
  const bearCase = directional
    .filter((item) => item.contribution < -1)
    .sort((left, right) => left.contribution - right.contribution)
    .slice(0, 3)
    .map((item) => `${item.label} (${item.value}) subtracts ${Math.abs(item.contribution).toFixed(1)} points.`);
  return {
    bullCase: bullCase.length ? bullCase : ['No high-conviction bullish argument is confirmed.'],
    bearCase: bearCase.length ? bearCase : ['No high-conviction bearish argument is confirmed.']
  };
}

interface FinalizeInput {
  slug: MarketSlug;
  title: string;
  subtitle: string;
  horizon: string;
  coreAvailable: boolean;
  price: number | null;
  priceChangePct: number | null;
  updatedAt: string | null;
  metrics: Metric[];
  analystSpecs: AnalystSpec[];
  features: Feature[];
  risks: string[];
  sources: SourceStatus[];
  setup: string[];
  headlines: MarketCard['headlines'];
  aiAnalysis: MarketCard['aiAnalysis'];
  options: MarketCard['options'];
  breadth: MarketCard['breadth'];
  derivatives: MarketCard['derivatives'];
  globalCues?: MarketCard['globalCues'];
  institutionalFlows?: MarketCard['institutionalFlows'];
  config: ModelConfig;
  now: number;
}

function finalize(input: FinalizeInput): MarketCard {
  const { config } = input;
  const weights = config.analystWeights;
  const enabled = input.features.filter((item) => !config.disabledFeatures.includes(item.key));
  const scoredFeatures = enabled.filter((item) => item.role !== 'context' && isNumber(item.normalized) && item.analyst);
  const featuresFor = (key: AnalystKey) => scoredFeatures.filter((item) => item.analyst === key
    && (key === 'risk' ? item.role === 'risk' : item.role === 'direction'));

  const raw = input.analystSpecs.map((spec) => {
    const items = featuresFor(spec.key);
    const rawScore = items.length ? items.reduce((sum, item) => sum + item.normalized!, 0) / items.length * 100 : undefined;
    const rule = config.confidenceRules[input.slug][spec.key];
    const confidence = rawScore == null
      ? 0
      : Math.round(clamp(spec.confidence ?? rule.base + rule.perInput * items.length, 0, 100));
    return { spec, items, rawScore, confidence };
  });

  // Only analysts with data, a positive weight and positive confidence vote.
  const voting = raw.filter((item) => item.rawScore != null && item.confidence > 0 && weights[item.spec.key] > 0);
  const effectiveWeight = voting.reduce((sum, item) => sum + weights[item.spec.key] * item.confidence / 100, 0);
  const rawFinal = effectiveWeight
    ? voting.reduce((sum, item) => sum + item.rawScore! * weights[item.spec.key] * item.confidence / 100, 0) / effectiveWeight
    : 0;
  const score = Math.round(clamp(rawFinal, -100, 100));
  const shareOf = (key: AnalystKey, confidence: number) => effectiveWeight && weights[key] > 0
    ? weights[key] * confidence / 100 / effectiveWeight
    : 0;

  const analysts: AnalystSignal[] = raw.map(({ spec, items, rawScore, confidence }) => {
    const safeScore = Math.round(clamp(rawScore ?? 0, -100, 100));
    const share = rawScore == null ? 0 : shareOf(spec.key, confidence);
    return {
      key: spec.key,
      name: spec.name,
      score: safeScore,
      confidence,
      stance: stance(safeScore, config.stanceThreshold),
      summary: spec.summary(rawScore, items.length),
      effectiveWeightPct: Number((share * 100).toFixed(1)),
      contribution: Number(((rawScore ?? 0) * share).toFixed(2)),
      inputs: items.length
    };
  });

  const rawVerdict = verdictFromScore(score, config.verdictThreshold);
  const unavailable = !input.coreAvailable;
  const verdict: Verdict = unavailable ? 'UNAVAILABLE' : rawVerdict;
  const votingAnalysts = analysts.filter((item) => voting.some((vote) => vote.spec.key === item.key));
  const agreement = votingAnalysts.length
    ? votingAnalysts.filter((item) => item.stance === rawVerdict || (rawVerdict === 'NEUTRAL' && Math.abs(item.score) < 25)).length / votingAnalysts.length
    : 0;
  const maxWeight = (Object.keys(weights) as AnalystKey[]).reduce((sum, key) => sum + weights[key], 0);
  const coverage = maxWeight ? clamp(effectiveWeight / maxWeight, 0, 1) : 0;
  const risk = analysts.find((item) => item.key === 'risk' && item.confidence > 0);
  const riskAdjustment = risk ? clamp(risk.score * risk.confidence / 100 * 0.12, -12, 4) : -4;
  const confidence = unavailable ? 0 : signalQuality({ coverage, agreement, score, riskAdjustment });
  const quality: SignalQuality = {
    score: confidence,
    label: 'Signal quality (uncalibrated)',
    coverage: Number(coverage.toFixed(3)),
    agreement: Number(agreement.toFixed(3)),
    strength: Math.abs(score),
    riskAdjustment: Number(riskAdjustment.toFixed(2)),
    note: 'Measures data coverage, analyst agreement, score strength and risk conditions. It is not a probability of being correct.'
  };

  const evidence: EvidenceItem[] = enabled.map((item) => {
    if (item.role !== 'direction' || !isNumber(item.normalized) || !item.analyst) {
      return {
        key: item.key,
        label: item.label,
        value: item.value,
        score: item.role === 'risk' && isNumber(item.normalized) ? Number(item.normalized.toFixed(3)) : 0,
        weight: 0,
        contribution: 0,
        reason: item.reason,
        role: item.role === 'direction' ? 'context' : item.role,
        analyst: item.analyst
      };
    }
    const owner = raw.find((entry) => entry.spec.key === item.analyst)!;
    const share = owner.rawScore == null ? 0 : shareOf(item.analyst, owner.confidence) / owner.items.length;
    return {
      key: item.key,
      label: item.label,
      value: item.value,
      score: Number(item.normalized.toFixed(3)),
      weight: Number((share * 100).toFixed(1)),
      contribution: Number((item.normalized * 100 * share).toFixed(2)),
      reason: item.reason,
      role: 'direction',
      analyst: item.analyst
    };
  });
  const roleOrder: Record<EvidenceRole, number> = { direction: 0, risk: 1, context: 2 };
  evidence.sort((left, right) => roleOrder[left.role] - roleOrder[right.role] || Math.abs(right.contribution) - Math.abs(left.contribution));
  const directional = evidence.filter((item) => item.role === 'direction');
  const lead = directional[0];
  const support = directional[1];
  const titleCase = `${rawVerdict[0]}${rawVerdict.slice(1).toLowerCase()}`;
  const summary = unavailable
    ? 'Market-price evidence is missing, so news is shown for research but no directional call is issued.'
    : lead && support
      ? `${titleCase} composite at ${score}, led by ${lead.label.toLowerCase()} and ${support.label.toLowerCase()}.`
      : `${titleCase} composite at ${score}; signal coverage is still thin.`;
  const cases = buildCases(evidence);
  const staleSources = input.sources.filter((source) => source.status === 'stale').map((source) => source.name);
  const risks = staleSources.length
    ? [...input.risks, `Stale data excluded from scoring: ${staleSources.join(', ')}.`]
    : input.risks;

  const card: MarketCard = {
    slug: input.slug,
    title: input.title,
    subtitle: input.subtitle,
    availability: unavailable ? 'unavailable' : availabilityFromSources(input.sources),
    verdict,
    headline: unavailable ? 'Waiting for grounded market data' : `${titleCase} multi-analyst read`,
    summary,
    horizon: input.horizon,
    horizonMinutes: config.horizonMinutes[input.slug],
    lastUpdated: input.updatedAt,
    confidence,
    signalQuality: quality,
    score: unavailable ? 0 : score,
    probabilities: heuristicProbabilities(score, confidence, unavailable),
    probabilityKind: 'heuristic_uncalibrated',
    calibration: insufficientCalibration(),
    priceLabel: input.slug === 'nifty' ? 'NIFTY 50' : 'BTC',
    price: input.price,
    priceChangePct: input.priceChangePct,
    metrics: input.metrics,
    analysts,
    evidence,
    headlines: input.headlines,
    aiAnalysis: input.aiAnalysis,
    bullCase: cases.bullCase,
    bearCase: cases.bearCase,
    risks,
    sources: input.sources,
    setup: input.setup,
    trackRecord: emptyTrackRecord(),
    decision: { action: 'PAPER TRADE ONLY', copy: '', tone: 'neutral' },
    session: sessionInfo(input.slug, input.now, config),
    options: input.options,
    breadth: input.breadth,
    derivatives: input.derivatives,
    events: [],
    globalCues: input.globalCues ?? [],
    institutionalFlows: input.institutionalFlows ?? null,
    modelVersion: config.version
  };
  card.decision = researchDecision(card);
  return card;
}

export function scoreNifty(snapshot: NiftySnapshot, sources: SourceStatus[], options: ScoreOptions = {}): MarketCard {
  const config = options.config ?? DEFAULT_CONFIG;
  const now = options.now ?? Date.now();
  const r = config.ranges.nifty;
  const tech = snapshot.technical;
  const chain = snapshot.options;
  const breadth = snapshot.breadth;
  const changePct = percentChange(snapshot.spot, snapshot.previousClose);
  const vixChangePct = percentChange(snapshot.vix, snapshot.vixPreviousClose);
  const gapPct = percentChange(snapshot.sessionOpen, snapshot.previousClose);
  const pcr = snapshot.pcr ?? chain?.totalPcr ?? undefined;
  const maxPain = snapshot.maxPain ?? chain?.maxPain ?? undefined;
  const atmIv = snapshot.atmIv ?? chain?.atmIv ?? undefined;
  const maxPainDistancePct = isNumber(maxPain) && isNumber(snapshot.spot) && snapshot.spot > 0
    ? ((maxPain - snapshot.spot) / snapshot.spot) * 100
    : undefined;
  const legacyOiSkew = isNumber(snapshot.putOiChangePercent) && isNumber(snapshot.callOiChangePercent)
    ? snapshot.putOiChangePercent - snapshot.callOiChangePercent
    : undefined;
  const adNet = breadth && breadth.constituents > 0 ? (breadth.advances - breadth.declines) / breadth.constituents : undefined;

  const features: Feature[] = [];
  const add = (item: Feature | null) => { if (item) features.push(item); };
  // Direction: technical (all derived from the same price series, so they are correlated; see ablation report).
  add(changePct == null ? null : feature('direction', 'technical', 'spot', 'Spot move', pct(changePct), scaled(changePct, r.spotChangePct), `NIFTY vs previous close; ±${r.spotChangePct}% is full strength.`));
  add(tech?.emaSpreadPct == null ? null : feature('direction', 'technical', 'ema', 'EMA 12/26 trend', pct(tech.emaSpreadPct), scaled(tech.emaSpreadPct, r.emaSpreadPct), `Fast EMA vs slow EMA on 5m candles (warmed up with the previous session); ±${r.emaSpreadPct}% is full strength.`));
  add(tech?.rsi == null ? null : feature('direction', 'technical', 'rsi', 'RSI 14', tech.rsi.toFixed(1), scaled(tech.rsi - 50, r.rsiFromMid), `RSI distance from 50; 30/70 are full strength.`));
  add(tech?.macdHistogramPct == null ? null : feature('direction', 'technical', 'macd', 'MACD histogram', pct(tech.macdHistogramPct), scaled(tech.macdHistogramPct, r.macdHistogramPct), `MACD minus signal as % of price; ±${r.macdHistogramPct}% is full strength.`));
  add(tech?.recentMomentumPct == null ? null : feature('direction', 'technical', 'momentum', 'Session momentum', pct(tech.recentMomentumPct), scaled(tech.recentMomentumPct, r.momentumPct), `Return over the last hour of this session only (no overnight gap); ±${r.momentumPct}% is full strength.`));
  // Direction: positioning.
  add(chain?.oiFlow == null ? null : feature('direction', 'positioning', 'oi-flow', 'Near-ATM OI flow', `${chain.oiFlow >= 0 ? '+' : ''}${chain.oiFlow.toFixed(2)}`, scaled(chain.oiFlow, r.oiFlow), chain.flowAdjusted
    ? 'Heuristic: OI change classified by the premium move left after removing delta x spot change and theta decay. It does not reveal intent.'
    : 'Heuristic: OI change classified by raw premium moves, which partly echo the price move. It does not reveal intent.'));
  add(adNet == null ? null : feature('direction', 'positioning', 'breadth', 'Advance/decline', `${breadth!.advances}↑ ${breadth!.declines}↓`, scaled(adNet, r.advanceDecline), `Net advancers as a share of constituents; ±${r.advanceDecline} is full strength.`));
  // Direction: sentiment.
  add(snapshot.sentiment ? feature('direction', 'sentiment', 'news', 'Headline sentiment', `${snapshot.sentiment.deterministicScore >= 0 ? '+' : ''}${snapshot.sentiment.deterministicScore}/100`, snapshot.sentiment.deterministicScore / 100, 'Rules-based, recency-weighted headline tone. AI commentary does not change this score.') : null);
  // Risk (signal quality only).
  add(vixChangePct == null || snapshot.vix == null ? null : feature('risk', 'risk', 'vix', 'India VIX change', `${snapshot.vix.toFixed(2)} (${pct(vixChangePct)})`, scaled(-vixChangePct, r.vixChangePct), 'Rising VIX lowers signal quality; it does not change direction.'));
  add(atmIv == null ? null : feature('risk', 'risk', 'atm-iv', 'ATM implied volatility', `${atmIv.toFixed(2)}%`, scaled(18 - atmIv, r.atmIvFromNeutral), 'High IV means larger expected swings and expensive options.'));
  add(snapshot.atmSpreadPercent == null ? null : feature('risk', 'risk', 'spread', 'ATM bid-ask spread', `${snapshot.atmSpreadPercent.toFixed(2)}%`, scaled(1.2 - snapshot.atmSpreadPercent, r.atmSpreadPct), 'Wide spreads make entries and exits costly.'));
  // Context only.
  if (isNumber(pcr)) add(context('pcr', 'Put-call ratio (all strikes)', pcr.toFixed(2), 'Not scored: a universal linear PCR rule has not been validated across regimes.'));
  if (isNumber(chain?.nearbyPcr)) add(context('pcr-near', 'Near-ATM PCR', chain!.nearbyPcr!.toFixed(2), `Put/call OI within ${chain!.strikesUsed} strikes of ATM.`));
  if (legacyOiSkew != null) add(context('oi-skew', 'Put vs call OI change (all strikes)', pct(legacyOiSkew), 'Not scored: aggregate OI change does not show who opened the positions.'));
  if (maxPainDistancePct != null) add(context('max-pain', 'Max pain', `${maxPain!.toFixed(0)} (${pct(maxPainDistancePct)})`, 'Context only; not a reliable price magnet.'));
  const support = chain?.supportZones[0];
  const resistance = chain?.resistanceZones[0];
  if (support) add(context('support', 'Put OI concentration (support zone)', `${support.strike} (${pct(support.distancePct)})`, 'Heuristic zone from put OI concentration below spot; not a guaranteed level.'));
  if (resistance) add(context('resistance', 'Call OI concentration (resistance zone)', `${resistance.strike} (${pct(resistance.distancePct)})`, 'Heuristic zone from call OI concentration above spot; not a guaranteed level.'));
  if (isNumber(chain?.ivSkew)) add(context('iv-skew', 'Put-call IV skew', `${chain!.ivSkew! >= 0 ? '+' : ''}${chain!.ivSkew!.toFixed(2)} pts`, 'Near-ATM put IV minus call IV; higher means more demand for downside protection.'));
  if (isNumber(chain?.daysToExpiry)) add(context('expiry', 'Days to expiry', String(chain!.daysToExpiry), 'Positioning near expiry is noisier and gamma risk is higher.'));
  if (isNumber(snapshot.futures?.vwapDistancePct)) add(context('vwap', 'Futures vs session VWAP', pct(snapshot.futures!.vwapDistancePct!), 'Near-month NIFTY futures price vs volume-weighted average price.'));
  if (isNumber(snapshot.futures?.relativeVolume)) add(context('rvol', 'Relative futures volume', `${snapshot.futures!.relativeVolume!.toFixed(2)}x`, 'Session volume so far vs previous sessions at the same time of day.'));
  if (gapPct != null) add(context('gap', 'Opening gap', pct(gapPct), 'Session open vs previous close.'));
  if (isNumber(tech?.atrPct)) add(context('atr', 'ATR (5m, 14)', `${tech!.atrPct!.toFixed(2)}%`, 'Average true range as % of price.'));
  if (tech?.regime) add(context('regime', 'Market regime', `${tech.regime} (ER ${tech.efficiencyRatio!.toFixed(2)})`, 'Efficiency ratio ≥ 0.30 is labelled trending; label only.'));
  if (isNumber(breadth?.aboveVwapPct)) add(context('above-vwap', 'Constituents above VWAP', `${breadth!.aboveVwapPct!.toFixed(0)}%`, 'Share of Nifty 50 stocks trading above their session VWAP.'));
  if (breadth?.concentration) add(context('concentration', 'Move breadth', breadth.concentration, 'Broad vs concentrated participation.'));
  for (const cue of snapshot.globalCues ?? []) {
    add(context(`global-${cue.key}`, cue.name, `${cue.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}${cue.changePct == null ? '' : ` (${pct(cue.changePct)})`}`, `${cue.note} Context only; not validated for scoring.`));
  }
  if (snapshot.institutionalFlows) {
    const flows = snapshot.institutionalFlows;
    const crore = (value: number | null) => value == null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(0)} cr`;
    add(context('flows', `FII / DII net (${flows.date})`, `${crore(flows.fiiNetCr)} / ${crore(flows.diiNetCr)}`, flows.note));
  }
  if (isNumber(breadth?.bankNiftyRelativePct)) add(context('bank-rel', 'Bank Nifty vs Nifty', pct(breadth!.bankNiftyRelativePct!), 'Relative performance of the banking index.'));

  const metrics: Metric[] = [
    changePct == null ? null : metric('Spot change', pct(changePct), 'vs previous close', toneFromSigned(changePct)),
    tech?.rsi == null ? null : metric('RSI 14', tech.rsi.toFixed(1), `${tech.candleCount} 5m candles`, tech.rsi >= 55 ? 'positive' : tech.rsi <= 45 ? 'negative' : 'neutral'),
    vixChangePct == null || snapshot.vix == null ? null : metric('India VIX', `${snapshot.vix.toFixed(2)} (${pct(vixChangePct)})`, 'risk regime', toneFromSigned(vixChangePct, false)),
    !isNumber(pcr) ? null : metric('PCR', pcr.toFixed(2), 'context only', 'neutral'),
    chain?.oiFlow == null ? null : metric('OI flow', chain.oiFlow.toFixed(2), 'near-ATM, heuristic', toneFromSigned(chain.oiFlow)),
    breadth == null ? null : metric('Breadth', `${breadth.advances}/${breadth.declines}`, 'advancers/decliners', adNet == null ? 'neutral' : toneFromSigned(adNet)),
    atmIv == null ? null : metric('ATM IV', `${atmIv.toFixed(2)}%`, 'risk only', atmIv <= 18 ? 'positive' : atmIv >= 22 ? 'negative' : 'neutral'),
    snapshot.sentiment == null ? null : metric('News pulse', `${snapshot.sentiment.deterministicScore >= 0 ? '+' : ''}${snapshot.sentiment.deterministicScore}`, `rules · ${snapshot.sentiment.positive}/${snapshot.sentiment.negative} positive/negative`, toneFromSigned(snapshot.sentiment.deterministicScore))
  ].filter((item): item is Metric => Boolean(item));

  const risks: string[] = [];
  if (tech?.rsi != null && tech.rsi > 72) risks.push('RSI is overextended; bullish momentum may be vulnerable to mean reversion.');
  if (tech?.rsi != null && tech.rsi < 28) risks.push('RSI is deeply oversold; chasing downside has reversal risk.');
  if (atmIv != null && atmIv > 20) risks.push('ATM IV is elevated, making long-option entries expensive.');
  if (snapshot.atmSpreadPercent != null && snapshot.atmSpreadPercent > 1.4) risks.push('ATM spreads are wide enough to damage entries and exits.');
  if (isNumber(chain?.daysToExpiry) && chain!.daysToExpiry! <= 1) risks.push('Expiry is within a day: option positioning and gamma moves are unusually noisy.');
  if (tech?.regime === 'range-bound') risks.push('Price action is range-bound; trend and momentum inputs are less reliable in chop.');
  if (!snapshot.spot || !tech) risks.push('Price or candle confirmation is missing; headlines alone cannot issue a NIFTY call.');
  if (!risks.length) risks.push('No critical risk veto is active, but intraday signals can reverse quickly.');

  const hasTechnical = features.some((item) => item.analyst === 'technical' && item.role === 'direction');
  const hasPositioning = features.some((item) => item.analyst === 'positioning' && item.role === 'direction');
  return finalize({
    slug: 'nifty',
    title: 'Nifty 50 Research Desk',
    subtitle: 'Technical + options + breadth + news, with a separate risk check',
    horizon: 'Intraday, up to 3 hours (capped at the 15:30 close)',
    coreAvailable: Boolean(changePct != null || hasTechnical || hasPositioning),
    price: snapshot.spot ?? null,
    priceChangePct: changePct ?? null,
    updatedAt: snapshot.updatedAt ?? null,
    metrics,
    analystSpecs: [
      { key: 'technical', name: 'Technical Analyst', summary: (score, n) => score == null ? 'Intraday candles unavailable.' : `${n} price inputs (correlated) combine to ${Math.round(score)}.` },
      { key: 'positioning', name: 'Positioning & Breadth', summary: (score, n) => score == null ? 'Option flow and breadth unavailable.' : `${n} positioning inputs combine to ${Math.round(score)}. PCR and max pain are context only.` },
      {
        key: 'sentiment',
        name: 'News Sentiment',
        confidence: snapshot.sentiment?.confidence ?? 0,
        summary: (score) => score == null || !snapshot.sentiment ? 'Recent headlines unavailable.' : `Rules-based: ${snapshot.sentiment.positive} positive, ${snapshot.sentiment.negative} negative, ${snapshot.sentiment.neutral} neutral headlines. AI is explanation-only.`
      },
      { key: 'risk', name: 'Risk Manager', summary: (score) => score == null ? 'Volatility and execution-risk inputs unavailable.' : `VIX, IV and spread conditions combine to ${Math.round(score)}; affects signal quality only.` }
    ],
    features,
    risks,
    sources,
    setup: snapshot.spot ? [] : ['Add the free UPSTOX_ANALYTICS_TOKEN to unlock NIFTY price, candles, VIX and options.'],
    headlines: snapshot.sentiment?.headlines ?? [],
    aiAnalysis: snapshot.aiAnalysis ?? null,
    options: chain ?? null,
    breadth: breadth ?? null,
    derivatives: null,
    globalCues: snapshot.globalCues ?? [],
    institutionalFlows: snapshot.institutionalFlows ?? null,
    config,
    now
  });
}

function dominanceReading(snapshot: CryptoSnapshot) {
  const relative = isNumber(snapshot.ethChangePct) && isNumber(snapshot.btcChangePct) ? snapshot.ethChangePct - snapshot.btcChangePct : undefined;
  const market = snapshot.basketAverageChangePct ?? snapshot.btcChangePct;
  if (relative == null || !isNumber(market)) return 'Not enough data to interpret rotation.';
  const altsLead = relative > 0;
  if (market >= 0) return altsLead ? 'Alts leading a rising market: broad risk appetite.' : 'BTC leading a rising market: narrower, BTC-led move.';
  return altsLead ? 'Alts falling less than BTC: mixed rotation.' : 'BTC falling less than alts: defensive rotation, not a bullish sign.';
}

export function scoreCrypto(snapshot: CryptoSnapshot, sources: SourceStatus[], options: ScoreOptions = {}): MarketCard {
  const config = options.config ?? DEFAULT_CONFIG;
  const now = options.now ?? Date.now();
  const r = config.ranges.crypto;
  const tech = snapshot.technical;
  const breadthPct = snapshot.breadthPositiveRatio == null ? undefined : snapshot.breadthPositiveRatio * 100;
  const spreads = [snapshot.btcSpreadPercent, snapshot.ethSpreadPercent].filter(isNumber);
  const spreadBlend = spreads.length ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length : undefined;
  const realFearGreed = snapshot.fearGreed != null && !snapshot.fearGreedIsProxy ? snapshot.fearGreed : undefined;
  const derivatives = snapshot.derivatives;
  const relativeStrength = isNumber(snapshot.ethChangePct) && isNumber(snapshot.btcChangePct) ? snapshot.ethChangePct - snapshot.btcChangePct : undefined;

  const features: Feature[] = [];
  const add = (item: Feature | null) => { if (item) features.push(item); };
  add(snapshot.btcChangePct == null ? null : feature('direction', 'technical', 'btc', 'BTC 24h move', pct(snapshot.btcChangePct), scaled(snapshot.btcChangePct, r.btcChangePct), `±${r.btcChangePct}% is full strength.`));
  add(snapshot.ethChangePct == null ? null : feature('direction', 'technical', 'eth', 'ETH 24h move', pct(snapshot.ethChangePct), scaled(snapshot.ethChangePct, r.ethChangePct), `±${r.ethChangePct}% is full strength.`));
  add(tech?.emaSpreadPct == null ? null : feature('direction', 'technical', 'ema', 'BTC EMA 12/26 (1h)', pct(tech.emaSpreadPct), scaled(tech.emaSpreadPct, r.emaSpreadPct), `±${r.emaSpreadPct}% is full strength.`));
  add(tech?.rsi == null ? null : feature('direction', 'technical', 'rsi', 'BTC RSI 14 (1h)', tech.rsi.toFixed(1), scaled(tech.rsi - 50, r.rsiFromMid), 'RSI distance from 50; 30/70 are full strength.'));
  add(tech?.macdHistogramPct == null ? null : feature('direction', 'technical', 'macd', 'BTC MACD histogram', pct(tech.macdHistogramPct), scaled(tech.macdHistogramPct, r.macdHistogramPct), `±${r.macdHistogramPct}% is full strength.`));
  add(tech?.recentMomentumPct == null ? null : feature('direction', 'technical', 'momentum', 'BTC 12h momentum', pct(tech.recentMomentumPct), scaled(tech.recentMomentumPct, r.momentumPct), `±${r.momentumPct}% is full strength.`));
  add(breadthPct == null ? null : feature('direction', 'positioning', 'breadth', 'Top-10 breadth', `${breadthPct.toFixed(0)}% green`, scaled(snapshot.breadthPositiveRatio! - 0.5, r.breadthFromHalf), 'Share of a fixed 10-coin basket that is up over 24h.'));
  add(snapshot.sentiment ? feature('direction', 'sentiment', 'news', 'Headline sentiment', `${snapshot.sentiment.deterministicScore >= 0 ? '+' : ''}${snapshot.sentiment.deterministicScore}/100`, snapshot.sentiment.deterministicScore / 100, 'Rules-based, recency-weighted headline tone. AI commentary does not change this score.') : null);
  add(realFearGreed == null ? null : feature('direction', 'sentiment', 'fear-greed', 'Fear & Greed', `${realFearGreed} · ${snapshot.fearGreedLabel || 'Unknown'}`, scaled(realFearGreed - 50, r.fearGreedFromMid), 'Alternative.me daily index; extremes also raise reversal risk.'));
  add(spreadBlend == null ? null : feature('risk', 'risk', 'spread', 'BTC/ETH spread', `${spreadBlend.toFixed(3)}%`, scaled(r.spreadPct - spreadBlend, r.spreadPct), 'Execution cost; affects signal quality only.'));
  add(tech?.volatilityPct == null ? null : feature('risk', 'risk', 'volatility', 'Hourly realised volatility', `${tech.volatilityPct.toFixed(2)}%`, scaled(r.volatilityPct - tech.volatilityPct, r.volatilityPct), 'Higher volatility makes the read less stable; affects signal quality only.'));
  if (snapshot.fearGreedIsProxy && snapshot.fearGreed != null) add(context('mood-proxy', 'Market mood proxy (not Fear & Greed)', String(snapshot.fearGreed), 'Local composite of inputs already scored elsewhere; excluded to avoid double counting.'));
  if (snapshot.marketCapChangePct != null) add(context('mcap', 'Total market cap 24h', pct(snapshot.marketCapChangePct), 'Not scored: provider windows are inconsistent.'));
  if (snapshot.btcDominance != null) add(context('dominance', 'BTC dominance', `${snapshot.btcDominance.toFixed(1)}%`, `${dominanceReading(snapshot)} Falling dominance alone is not bullish.`));
  if (relativeStrength != null) add(context('eth-btc', 'ETH vs BTC (24h)', pct(relativeStrength), 'Relative strength; read together with market direction and breadth.'));
  if (isNumber(snapshot.basketAverageChangePct)) add(context('basket', 'Top-10 average 24h', pct(snapshot.basketAverageChangePct), 'Equal-weighted basket return.'));
  if (isNumber(snapshot.btcReturn1hPct)) add(context('btc-1h', 'BTC 1h return', pct(snapshot.btcReturn1hPct), 'Short-horizon move from closed hourly candles.'));
  if (isNumber(snapshot.btcReturn4hPct)) add(context('btc-4h', 'BTC 4h return', pct(snapshot.btcReturn4hPct), 'Closer to the forecast horizon than the 24h move.'));
  if (tech?.regime) add(context('regime', 'Market regime', `${tech.regime} (ER ${tech.efficiencyRatio!.toFixed(2)})`, 'Efficiency ratio ≥ 0.30 is labelled trending; label only.'));
  if (isNumber(derivatives?.fundingRatePct)) add(context('funding', 'Perp funding rate', `${derivatives!.fundingRatePct!.toFixed(4)}%${isNumber(derivatives!.fundingPercentile) ? ` (p${derivatives!.fundingPercentile!.toFixed(0)})` : ''}`, 'Crowding context, not a contrarian instruction.'));
  if (isNumber(derivatives?.openInterestChangePct)) add(context('open-interest', 'Futures OI 24h change', pct(derivatives!.openInterestChangePct!), 'Leverage entering or leaving the market.'));
  if (isNumber(derivatives?.basisPct)) add(context('basis', 'Perp premium (mark vs index)', pct(derivatives!.basisPct!), 'Positive means perps trade above spot.'));
  if (isNumber(derivatives?.orderBookImbalance)) add(context('book', 'Spot order-book imbalance', derivatives!.orderBookImbalance!.toFixed(2), 'Bid minus ask depth within 0.5% of mid, / total. A snapshot; easily spoofed.'));

  const metrics: Metric[] = [
    snapshot.btcChangePct == null ? null : metric('BTC 24h', pct(snapshot.btcChangePct), 'leader momentum', toneFromSigned(snapshot.btcChangePct)),
    isNumber(snapshot.btcReturn4hPct) ? metric('BTC 4h', pct(snapshot.btcReturn4hPct), 'context', toneFromSigned(snapshot.btcReturn4hPct)) : null,
    tech?.rsi == null ? null : metric('BTC RSI 14', tech.rsi.toFixed(1), `${tech.candleCount} hourly candles`, tech.rsi >= 55 ? 'positive' : tech.rsi <= 45 ? 'negative' : 'neutral'),
    breadthPct == null ? null : metric('Top-10 breadth', `${breadthPct.toFixed(0)}%`, 'large caps in green', breadthPct >= 60 ? 'positive' : breadthPct <= 40 ? 'negative' : 'neutral'),
    snapshot.fearGreed == null ? null : metric(snapshot.fearGreedIsProxy ? 'Mood proxy' : 'Fear & Greed', String(snapshot.fearGreed), snapshot.fearGreedIsProxy ? 'not scored' : snapshot.fearGreedLabel || 'market mood', snapshot.fearGreed >= 55 ? 'positive' : snapshot.fearGreed <= 45 ? 'negative' : 'neutral'),
    isNumber(derivatives?.fundingRatePct) ? metric('Funding', `${derivatives!.fundingRatePct!.toFixed(4)}%`, 'context', 'neutral') : null,
    snapshot.sentiment == null ? null : metric('News pulse', `${snapshot.sentiment.deterministicScore >= 0 ? '+' : ''}${snapshot.sentiment.deterministicScore}`, `rules · ${snapshot.sentiment.positive}/${snapshot.sentiment.negative} positive/negative`, toneFromSigned(snapshot.sentiment.deterministicScore)),
    spreadBlend == null ? null : metric('Execution spread', `${spreadBlend.toFixed(3)}%`, 'BTC/ETH average', spreadBlend <= 0.05 ? 'positive' : spreadBlend >= 0.15 ? 'negative' : 'neutral')
  ].filter((item): item is Metric => Boolean(item));

  const risks: string[] = [];
  if (realFearGreed != null && realFearGreed >= 80) risks.push('Extreme greed raises crowded-position and reversal risk.');
  if (realFearGreed != null && realFearGreed <= 20) risks.push('Extreme fear can accelerate liquidation, but also creates squeeze risk.');
  if (tech?.rsi != null && tech.rsi > 72) risks.push('Hourly RSI is overbought; chasing upside has mean-reversion risk.');
  if (tech?.rsi != null && tech.rsi < 28) risks.push('Hourly RSI is oversold; chasing downside has squeeze risk.');
  if (tech?.volatilityPct != null && tech.volatilityPct > 1.5) risks.push('Hourly realised volatility is elevated, so the read is less stable.');
  if (isNumber(derivatives?.fundingPercentile) && derivatives!.fundingPercentile! >= 90) risks.push('Funding is in its top decile: longs are crowded (context, not a sell signal).');
  if (isNumber(derivatives?.fundingPercentile) && derivatives!.fundingPercentile! <= 10) risks.push('Funding is in its bottom decile: shorts are crowded (context, not a buy signal).');
  if (tech?.regime === 'range-bound') risks.push('Hourly price action is range-bound; momentum inputs are less reliable.');
  if (!risks.length) risks.push('Crypto trades continuously; a fresh headline or liquidation cascade can invalidate this read.');

  const hasTechnical = features.some((item) => item.analyst === 'technical' && item.role === 'direction');
  const newsConfidence = snapshot.sentiment?.confidence;
  const sentimentConfidences = [newsConfidence, realFearGreed == null ? undefined : 75].filter(isNumber);
  return finalize({
    slug: 'crypto',
    title: 'Crypto Research Desk',
    subtitle: 'Technical + breadth + sentiment, with a separate risk check',
    horizon: 'Next 6 hours',
    coreAvailable: Boolean(snapshot.btcPrice != null || hasTechnical),
    price: snapshot.btcPrice ?? null,
    priceChangePct: snapshot.btcChangePct ?? null,
    updatedAt: snapshot.updatedAt ?? null,
    metrics,
    analystSpecs: [
      { key: 'technical', name: 'Technical Analyst', summary: (score, n) => score == null ? 'BTC candles unavailable.' : `${n} price inputs (correlated) combine to ${Math.round(score)}.` },
      { key: 'positioning', name: 'Market Breadth', summary: (score) => score == null ? 'Broad-market participation unavailable.' : `Fixed-basket breadth reads ${Math.round(score)}. Dominance and derivatives are context only.` },
      {
        key: 'sentiment',
        name: 'Sentiment Analyst',
        confidence: sentimentConfidences.length ? sentimentConfidences.reduce((sum, value) => sum + value, 0) / sentimentConfidences.length : 0,
        summary: (score) => score == null ? 'News and sentiment gauges unavailable.' : `Rules-based headline tone${realFearGreed == null ? '' : ' and Fear & Greed'} combine to ${Math.round(score)}; AI is explanation-only.`
      },
      { key: 'risk', name: 'Risk Manager', summary: (score) => score == null ? 'Liquidity and volatility inputs unavailable.' : `Spread and realised-volatility conditions combine to ${Math.round(score)}; affects signal quality only.` }
    ],
    features,
    risks,
    sources,
    setup: [],
    headlines: snapshot.sentiment?.headlines ?? [],
    aiAnalysis: snapshot.aiAnalysis ?? null,
    options: null,
    breadth: null,
    derivatives: derivatives ?? null,
    config,
    now
  });
}
