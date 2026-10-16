import type { AnalystSignal, MarketCard } from './types.js';

type MarketSlug = MarketCard['slug'];
type AnalystKey = AnalystSignal['key'];

// Bump whenever scoring logic, features or defaults change. Track records and
// evaluation reports are always grouped by this value.
export const MODEL_VERSION = 'research-desk-v4';

export interface OutcomeThresholds {
  /** Actual outcome is UP when the return is strictly greater than +upPct. */
  upPct: number;
  /** Actual outcome is DOWN when the return is strictly less than -downPct. */
  downPct: number;
}

export interface AnalystConfidenceRule {
  /** Confidence when the analyst has at least one valid input. */
  base: number;
  /** Added per valid input. */
  perInput: number;
}

export interface ModelConfig {
  version: string;
  /** Risk is 0 by design: it can change signal quality, never direction. */
  analystWeights: Record<AnalystKey, number>;
  /** |score| at or above this becomes BULLISH/BEARISH. */
  verdictThreshold: number;
  /** |analyst score| at or above this gives the analyst a directional stance. */
  stanceThreshold: number;
  outcome: Record<MarketSlug, OutcomeThresholds>;
  /** Nominal forecast horizon. Nifty targets are capped at the session close. */
  horizonMinutes: Record<MarketSlug, number>;
  /** Nifty predictions are skipped when less than this remains before close. */
  minIntradayHorizonMinutes: number;
  /** One prediction per market per slot of this length (deduplicated by id). */
  predictionSlotMinutes: number;
  confidenceRules: Record<MarketSlug, Record<AnalystKey, AnalystConfidenceRule>>;
  /**
   * "Full-strength" move for each normalised feature: scaled(value, range)
   * maps value/range into [-1, 1]. All ranges are hand-chosen defaults and
   * have NOT been fitted; see REPO_LOGIC.md and the backtest report.
   */
  ranges: {
    nifty: {
      spotChangePct: number;
      emaSpreadPct: number;
      rsiFromMid: number;
      macdHistogramPct: number;
      momentumPct: number;
      oiFlow: number;
      advanceDecline: number;
      vixChangePct: number;
      atmIvFromNeutral: number;
      atmSpreadPct: number;
    };
    crypto: {
      btcChangePct: number;
      ethChangePct: number;
      emaSpreadPct: number;
      rsiFromMid: number;
      macdHistogramPct: number;
      momentumPct: number;
      breadthFromHalf: number;
      fearGreedFromMid: number;
      spreadPct: number;
      volatilityPct: number;
    };
  };
  /** Feature keys excluded from scoring (used by ablation runs). */
  disabledFeatures: string[];
}

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const DEFAULT_CONFIG: ModelConfig = {
  version: MODEL_VERSION,
  analystWeights: { technical: 30, positioning: 30, sentiment: 22, risk: 0 },
  verdictThreshold: 30,
  stanceThreshold: 15,
  outcome: {
    nifty: { upPct: 0.2, downPct: 0.2 },
    crypto: { upPct: 0.2, downPct: 0.2 }
  },
  horizonMinutes: { nifty: 180, crypto: 360 },
  minIntradayHorizonMinutes: 60,
  predictionSlotMinutes: 60,
  confidenceRules: {
    nifty: {
      technical: { base: 25, perInput: 14 },
      positioning: { base: 25, perInput: 20 },
      sentiment: { base: 0, perInput: 0 },
      risk: { base: 25, perInput: 20 }
    },
    crypto: {
      technical: { base: 20, perInput: 12 },
      positioning: { base: 25, perInput: 20 },
      sentiment: { base: 0, perInput: 0 },
      risk: { base: 35, perInput: 22 }
    }
  },
  ranges: {
    nifty: {
      spotChangePct: 1.1,
      emaSpreadPct: 0.35,
      rsiFromMid: 20,
      macdHistogramPct: 0.12,
      momentumPct: 0.7,
      oiFlow: 0.6,
      advanceDecline: 0.5,
      vixChangePct: 7,
      atmIvFromNeutral: 9,
      atmSpreadPct: 1.2
    },
    crypto: {
      btcChangePct: 3.5,
      ethChangePct: 4,
      emaSpreadPct: 1.2,
      rsiFromMid: 20,
      macdHistogramPct: 0.3,
      momentumPct: 3,
      breadthFromHalf: 0.35,
      fearGreedFromMid: 32,
      spreadPct: 0.1,
      volatilityPct: 1.2
    }
  },
  disabledFeatures: []
};

/** Runtime config: defaults plus env overrides for the evaluation thresholds. */
export function loadConfig(): ModelConfig {
  return {
    ...DEFAULT_CONFIG,
    outcome: {
      nifty: {
        upPct: envNumber('NIFTY_OUTCOME_UP_PCT', DEFAULT_CONFIG.outcome.nifty.upPct),
        downPct: envNumber('NIFTY_OUTCOME_DOWN_PCT', DEFAULT_CONFIG.outcome.nifty.downPct)
      },
      crypto: {
        upPct: envNumber('CRYPTO_OUTCOME_UP_PCT', DEFAULT_CONFIG.outcome.crypto.upPct),
        downPct: envNumber('CRYPTO_OUTCOME_DOWN_PCT', DEFAULT_CONFIG.outcome.crypto.downPct)
      }
    }
  };
}
