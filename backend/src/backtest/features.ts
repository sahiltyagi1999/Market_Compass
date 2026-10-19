import type { CryptoSnapshot, MarketCard, NiftySnapshot } from '../types.js';

/**
 * Raw (unscaled) inputs for the experimental learned model. These are the
 * same values the live model sees at the decision time; scaling and
 * imputation are learned from training rows only (see logistic.ts).
 */
export const FEATURES: Record<MarketCard['slug'], string[]> = {
  crypto: [
    'btcChange24h', 'ethChange24h', 'emaSpreadPct', 'rsi', 'macdHistogramPct', 'momentum12h',
    'volatilityPct', 'atrPct', 'efficiencyRatio', 'breadthRatio', 'basketAverage24h', 'fearGreed',
    'btcReturn1h', 'btcReturn4h', 'ethMinusBtc24h'
  ],
  nifty: [
    'spotChangePct', 'gapPct', 'emaSpreadPct', 'rsi', 'macdHistogramPct', 'sessionMomentum',
    'volatilityPct', 'atrPct', 'efficiencyRatio', 'vixChangePct'
  ]
};

const change = (now?: number, before?: number) => now != null && before ? ((now - before) / before) * 100 : undefined;

export function extractFeatures(market: MarketCard['slug'], snapshot: NiftySnapshot | CryptoSnapshot): Array<number | undefined> {
  const tech = snapshot.technical;
  if (market === 'crypto') {
    const s = snapshot as CryptoSnapshot;
    return [
      s.btcChangePct, s.ethChangePct, tech?.emaSpreadPct, tech?.rsi, tech?.macdHistogramPct, tech?.recentMomentumPct,
      tech?.volatilityPct, tech?.atrPct, tech?.efficiencyRatio, s.breadthPositiveRatio, s.basketAverageChangePct,
      s.fearGreedIsProxy ? undefined : s.fearGreed, s.btcReturn1hPct, s.btcReturn4hPct,
      s.ethChangePct != null && s.btcChangePct != null ? s.ethChangePct - s.btcChangePct : undefined
    ];
  }
  const s = snapshot as NiftySnapshot;
  return [
    change(s.spot, s.previousClose), change(s.sessionOpen, s.previousClose), tech?.emaSpreadPct, tech?.rsi,
    tech?.macdHistogramPct, tech?.recentMomentumPct, tech?.volatilityPct, tech?.atrPct, tech?.efficiencyRatio,
    change(s.vix, s.vixPreviousClose)
  ];
}
