export type Availability = 'live' | 'partial' | 'unavailable';
export type Verdict = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNAVAILABLE';
export type SourceState = 'live' | 'missing' | 'error';
export type Tone = 'positive' | 'negative' | 'neutral';

export interface SourceStatus {
  name: string;
  status: SourceState;
  message: string;
  optional?: boolean;
}

export interface Metric {
  label: string;
  value: string;
  note: string;
  tone: Tone;
}

export interface EvidenceItem {
  key: string;
  label: string;
  value: string;
  score: number;
  weight: number;
  contribution: number;
  reason: string;
}

export interface AnalystSignal {
  key: 'technical' | 'positioning' | 'sentiment' | 'risk';
  name: string;
  score: number;
  confidence: number;
  stance: Exclude<Verdict, 'UNAVAILABLE'>;
  summary: string;
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

export interface TrackRecord {
  resolved: number;
  pending: number;
  hitRate: number | null;
  note: string;
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
  lastUpdated: string | null;
  confidence: number;
  score: number;
  probabilities: DirectionProbabilities;
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
}

export interface DashboardResponse {
  generatedAt: string;
  modelVersion: string;
  cards: MarketCard[];
  notes: string[];
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
  candleCount: number;
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

export interface NiftySnapshot {
  spot?: number;
  previousClose?: number;
  vix?: number;
  vixPreviousClose?: number;
  pcr?: number;
  callOiChangePercent?: number;
  putOiChangePercent?: number;
  atmSpreadPercent?: number;
  atmIv?: number;
  maxPain?: number;
  technical?: TechnicalSnapshot;
  sentiment?: SentimentSnapshot;
  aiAnalysis?: AiMarketAnalysis;
  updatedAt?: string;
}

export interface CryptoSnapshot {
  btcPrice?: number;
  btcChangePct?: number;
  ethPrice?: number;
  ethChangePct?: number;
  marketCapChangePct?: number;
  btcDominance?: number;
  breadthPositiveRatio?: number;
  btcSpreadPercent?: number;
  ethSpreadPercent?: number;
  fearGreed?: number;
  fearGreedLabel?: string;
  technical?: TechnicalSnapshot;
  sentiment?: SentimentSnapshot;
  aiAnalysis?: AiMarketAnalysis;
  updatedAt?: string;
}
