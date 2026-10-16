export type Availability = 'live' | 'partial' | 'unavailable';
export type Verdict = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNAVAILABLE';
export type SourceState = 'live' | 'missing' | 'error' | 'stale';
export type Tone = 'positive' | 'negative' | 'neutral';

export interface SourceStatus {
  name: string;
  status: SourceState;
  message: string;
  optional?: boolean;
  /** When the provider says the value was observed (exchange/provider time). */
  observedAt?: string;
  /** When this server retrieved it. */
  retrievedAt?: string;
  ageSeconds?: number;
  maxAgeSeconds?: number;
  /** True when served from an earlier fetch instead of a fresh request. */
  fromCache?: boolean;
}

export interface Metric {
  label: string;
  value: string;
  note: string;
  tone: Tone;
}

/**
 * direction: moves the directional score (contribution is in score points and
 *            all direction contributions sum to the final score).
 * risk:      feeds the risk manager, which only changes signal quality.
 * context:   shown for research; never changes score or signal quality.
 */
export type EvidenceRole = 'direction' | 'risk' | 'context';

export interface EvidenceItem {
  key: string;
  label: string;
  value: string;
  /** Normalised feature value in [-1, 1]; 0 for context items. */
  score: number;
  /** Effective share of the final score (%) for direction items, else 0. */
  weight: number;
  /** Score points this item adds to the final score (direction only). */
  contribution: number;
  reason: string;
  role: EvidenceRole;
  analyst?: AnalystSignal['key'];
}

export interface AnalystSignal {
  key: 'technical' | 'positioning' | 'sentiment' | 'risk';
  name: string;
  score: number;
  confidence: number;
  stance: Exclude<Verdict, 'UNAVAILABLE'>;
  summary: string;
  /** Weight actually applied in the aggregate (weight x confidence share, %). */
  effectiveWeightPct: number;
  /** Score points this analyst adds to the final score. */
  contribution: number;
  inputs: number;
}

export interface HeadlineSignal {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  sentiment: number;
  tone: Tone;
  aiImpact?: Exclude<Verdict, 'UNAVAILABLE'>;
  aiImportance?: 'HIGH' | 'MEDIUM' | 'LOW';
  aiExplanation?: string;
}

export interface AiMarketAnalysis {
  model: string;
  overallImpact: Exclude<Verdict, 'UNAVAILABLE'>;
  sentimentScore: number;
  confidence: number;
  summary: string;
  keyDrivers: string[];
  risks: string[];
  analysedAt: string;
}

export interface DirectionProbabilities {
  bullish: number;
  neutral: number;
  bearish: number;
}

export interface SignalQuality {
  /** Same number as MarketCard.confidence (kept for API compatibility). */
  score: number;
  label: 'Signal quality (uncalibrated)';
  coverage: number;
  agreement: number;
  strength: number;
  riskAdjustment: number;
  note: string;
}

export interface CalibrationStatus {
  /** no_skill: enough data, but held-out Brier did not beat the training class-frequency forecast. */
  status: 'insufficient_data' | 'calibrated' | 'no_skill';
  method: string;
  /** Resolved, non-overlapping predictions available for this model version. */
  sampleSize: number;
  required: number;
  calibratedProbabilities: DirectionProbabilities | null;
  brier: number | null;
  logLoss: number | null;
  heuristicBrier: number | null;
  /** Held-out Brier of the training class-frequency forecast (the bar to beat). */
  empiricalBrier: number | null;
  note: string;
}

export interface TrackRecord {
  resolved: number;
  pending: number;
  /** Predictions that could not be evaluated within their horizon. */
  unresolvable: number;
  /** Raw hit rate over all resolved predictions (%), overlapping windows included. */
  hitRate: number | null;
  nonOverlapping: {
    n: number;
    hitRate: number | null;
    ci95: { low: number; high: number } | null;
    alwaysNeutralHitRate: number | null;
    /** Hit rate of always predicting the most frequent class on the same sample. */
    majorityClassHitRate: number | null;
    balancedAccuracy: number | null;
  };
  minimumSample: number;
  note: string;
}

export interface ResearchDecision {
  action: string;
  copy: string;
  tone: 'bullish' | 'bearish' | 'neutral';
}

export interface SessionInfo {
  open: boolean;
  label: string;
  detail: string;
  /** Prediction horizon end if a forecast were made now. */
  targetAt: string | null;
}

export interface OptionZone {
  strike: number;
  oi: number;
  oiChange: number;
  distancePct: number;
}

export interface OptionsDetail {
  expiry: string;
  daysToExpiry: number | null;
  atmStrike: number | null;
  strikesUsed: number;
  nearbyPcr: number | null;
  totalPcr: number | null;
  /** -1..1 heuristic: price/premium-aware OI flow near the money. */
  oiFlow: number | null;
  /** True when premium changes were adjusted for the underlying move (delta) and decay (theta). */
  flowAdjusted: boolean;
  flowBreakdown: Array<{ label: string; contracts: number; lean: Tone }>;
  supportZones: OptionZone[];
  resistanceZones: OptionZone[];
  maxPain: number | null;
  ivSkew: number | null;
  atmIv: number | null;
}

export interface NiftyBreadth {
  constituents: number;
  advances: number;
  declines: number;
  unchanged: number;
  advanceDeclineRatio: number | null;
  aboveVwapPct: number | null;
  /** Share of the index move explained by the top 5 movers by index weight proxy. */
  concentration: 'broad' | 'mixed' | 'narrow' | null;
  sectors: Array<{ name: string; changePct: number; relativeToNiftyPct: number | null }>;
  bankNiftyRelativePct: number | null;
}

export interface CryptoDerivatives {
  source: string;
  fundingRatePct: number | null;
  fundingPercentile: number | null;
  openInterest: number | null;
  openInterestChangePct: number | null;
  basisPct: number | null;
  orderBookImbalance: number | null;
}

export interface GlobalCue {
  key: string;
  name: string;
  price: number;
  changePct: number | null;
  observedAt: string | null;
  note: string;
}

export interface InstitutionalFlow {
  /** IST trading date the figures belong to. */
  date: string;
  fiiNetCr: number | null;
  diiNetCr: number | null;
  note: string;
}

export interface MarketEvent {
  name: string;
  market: 'nifty' | 'crypto' | 'both';
  scheduledAt: string;
  timezone: string;
  source: string;
  sourceUrl: string;
  verifiedOn: string;
  minutesUntil: number;
}

export interface MarketCard {
  slug: 'nifty' | 'crypto';
  title: string;
  subtitle: string;
  availability: Availability;
  verdict: Verdict;
  headline: string;
  summary: string;
  horizon: string;
  horizonMinutes: number;
  lastUpdated: string | null;
  /** Signal quality (uncalibrated). Not a probability of being correct. */
  confidence: number;
  signalQuality: SignalQuality;
  score: number;
  /** Heuristic distribution derived from score and signal quality; NOT calibrated. */
  probabilities: DirectionProbabilities;
  probabilityKind: 'heuristic_uncalibrated';
  calibration: CalibrationStatus;
  priceLabel: string;
  price: number | null;
  priceChangePct: number | null;
  metrics: Metric[];
  analysts: AnalystSignal[];
  evidence: EvidenceItem[];
  headlines: HeadlineSignal[];
  aiAnalysis: AiMarketAnalysis | null;
  bullCase: string[];
  bearCase: string[];
  risks: string[];
  sources: SourceStatus[];
  setup: string[];
  trackRecord: TrackRecord;
  decision: ResearchDecision;
  session: SessionInfo;
  options: OptionsDetail | null;
  breadth: NiftyBreadth | null;
  derivatives: CryptoDerivatives | null;
  events: MarketEvent[];
  /** Context only: not part of the directional score. */
  globalCues: GlobalCue[];
  institutionalFlows: InstitutionalFlow | null;
  modelVersion: string;
}

export interface StorageInfo {
  kind: 'file' | 'postgres';
  durable: boolean;
  note: string;
}

export interface DashboardResponse {
  generatedAt: string;
  nextUpdateAt: string;
  refreshMinutes: number;
  modelVersion: string;
  cards: MarketCard[];
  notes: string[];
  storage: StorageInfo;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalSnapshot {
  rsi?: number;
  emaFast?: number;
  emaSlow?: number;
  emaSpreadPct?: number;
  macdHistogramPct?: number;
  recentMomentumPct?: number;
  volatilityPct?: number;
  /** Average true range as % of last close. */
  atrPct?: number;
  /** Kaufman efficiency ratio 0..1 (1 = clean trend, ~0 = chop). */
  efficiencyRatio?: number;
  regime?: 'trending' | 'range-bound';
  candleCount: number;
  /** Candles in the current session (equals candleCount for 24/7 markets). */
  sessionCandleCount: number;
  lastCandleAt?: number;
}

export interface SentimentSnapshot {
  score: number;
  deterministicScore: number;
  aiScore?: number;
  method: 'deterministic' | 'ai_blend';
  confidence: number;
  positive: number;
  negative: number;
  neutral: number;
  headlines: HeadlineSignal[];
}

export interface FuturesSnapshot {
  instrumentKey: string;
  vwap?: number;
  lastPrice?: number;
  vwapDistancePct?: number;
  /** Cumulative session volume vs average of previous sessions at the same time. */
  relativeVolume?: number;
}

export interface NiftySnapshot {
  spot?: number;
  previousClose?: number;
  sessionOpen?: number;
  vix?: number;
  vixPreviousClose?: number;
  pcr?: number;
  callOiChangePercent?: number;
  putOiChangePercent?: number;
  atmSpreadPercent?: number;
  atmIv?: number;
  maxPain?: number;
  options?: OptionsDetail;
  breadth?: NiftyBreadth;
  futures?: FuturesSnapshot;
  globalCues?: GlobalCue[];
  institutionalFlows?: InstitutionalFlow;
  technical?: TechnicalSnapshot;
  sentiment?: SentimentSnapshot;
  aiAnalysis?: AiMarketAnalysis;
  updatedAt?: string;
}

export interface CryptoSnapshot {
  btcPrice?: number;
  btcChangePct?: number;
  btcReturn1hPct?: number;
  btcReturn4hPct?: number;
  ethPrice?: number;
  ethChangePct?: number;
  marketCapChangePct?: number;
  btcDominance?: number;
  breadthPositiveRatio?: number;
  basketAverageChangePct?: number;
  btcSpreadPercent?: number;
  ethSpreadPercent?: number;
  fearGreed?: number;
  fearGreedLabel?: string;
  /** True when fearGreed is the local proxy, not the Alternative.me index. */
  fearGreedIsProxy?: boolean;
  derivatives?: CryptoDerivatives;
  technical?: TechnicalSnapshot;
  sentiment?: SentimentSnapshot;
  aiAnalysis?: AiMarketAnalysis;
  updatedAt?: string;
}
