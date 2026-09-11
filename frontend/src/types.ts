export type Availability = 'live' | 'partial' | 'unavailable';
export type Verdict = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNAVAILABLE';
export type Tone = 'positive' | 'negative' | 'neutral';

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

export interface SourceStatus {
  name: string;
  status: 'live' | 'missing' | 'error';
  message: string;
  optional?: boolean;
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
  probabilities: { bullish: number; neutral: number; bearish: number };
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
  trackRecord: {
    resolved: number;
    pending: number;
    hitRate: number | null;
    note: string;
  };
}

export interface DashboardResponse {
  generatedAt: string;
  modelVersion: string;
  cards: MarketCard[];
  notes: string[];
}
