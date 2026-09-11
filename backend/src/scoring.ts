import type {
  AnalystSignal,
  CryptoSnapshot,
  DirectionProbabilities,
  EvidenceItem,
  MarketCard,
  Metric,
  NiftySnapshot,
  SourceStatus,
  Tone,
  TrackRecord,
  Verdict
} from './types.js';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const scaled = (value: number, range: number) => clamp(value / range, -1, 1);
const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
const emptyTrackRecord: TrackRecord = {
  resolved: 0,
  pending: 0,
  hitRate: null,
  note: 'Collecting forward outcomes; no resolved sample yet.'
};

function average(values: Array<number | null | undefined>) {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : undefined;
}

function toneFromSigned(value: number, positiveIsGood = true): Tone {
  if (Math.abs(value) < 0.01) return 'neutral';
  if (positiveIsGood) return value > 0 ? 'positive' : 'negative';
  return value > 0 ? 'negative' : 'positive';
}

function metric(label: string, value: string, note: string, tone: Tone): Metric {
  return { label, value, note, tone };
}

function evidence(key: string, label: string, value: string, score: number, weight: number, reason: string): EvidenceItem {
  return {
    key,
    label,
    value,
    score: Number(clamp(score, -1, 1).toFixed(3)),
    weight,
    contribution: Number((clamp(score, -1, 1) * weight).toFixed(2)),
    reason
  };
}

function stance(score: number): AnalystSignal['stance'] {
  if (score >= 15) return 'BULLISH';
  if (score <= -15) return 'BEARISH';
  return 'NEUTRAL';
}

function analyst(
  key: AnalystSignal['key'],
  name: string,
  score: number | undefined,
  confidence: number,
  summary: string
): AnalystSignal {
  const safeScore = Math.round(clamp(score ?? 0, -100, 100));
  return {
    key,
    name,
    score: safeScore,
    confidence: score == null ? 0 : Math.round(clamp(confidence, 0, 100)),
    stance: stance(safeScore),
    summary
  };
}

function availabilityFromSources(sources: SourceStatus[]) {
  const required = sources.filter((source) => !source.optional);
  const live = required.filter((source) => source.status === 'live').length;
  if (!live) return 'unavailable' as const;
  if (live === required.length) return 'live' as const;
  return 'partial' as const;
}

function verdictFromScore(score: number): Exclude<Verdict, 'UNAVAILABLE'> {
  if (score >= 18) return 'BULLISH';
  if (score <= -18) return 'BEARISH';
  return 'NEUTRAL';
}

function probabilities(score: number, confidence: number, unavailable: boolean): DirectionProbabilities {
  if (unavailable) return { bullish: 0, neutral: 100, bearish: 0 };
  const neutral = Math.round(clamp(52 - Math.abs(score) * 0.7 + (100 - confidence) * 0.12, 10, 82));
  const directional = 100 - neutral;
  const bullishShare = 1 / (1 + Math.exp(-score / 16));
  const bullish = Math.round(directional * bullishShare);
  return { bullish, neutral, bearish: 100 - neutral - bullish };
}

function buildCases(items: EvidenceItem[]) {
  const directional = items.filter((item) => !['spread', 'vix'].includes(item.key));
  const bullCase = directional
    .filter((item) => item.contribution > 1)
    .sort((left, right) => right.contribution - left.contribution)
    .slice(0, 3)
    .map((item) => `${item.label} (${item.value}) supports upside.`);
  const bearCase = directional
    .filter((item) => item.contribution < -1)
    .sort((left, right) => left.contribution - right.contribution)
    .slice(0, 3)
    .map((item) => `${item.label} (${item.value}) supports downside.`);
  return {
    bullCase: bullCase.length ? bullCase : ['No high-conviction bullish argument is confirmed.'],
    bearCase: bearCase.length ? bearCase : ['No high-conviction bearish argument is confirmed.']
  };
}

interface FinalizeInput {
  slug: MarketCard['slug'];
  title: string;
  subtitle: string;
  horizon: string;
  coreAvailable: boolean;
  price: number | null;
  priceChangePct: number | null;
  updatedAt: string | null;
  metrics: Metric[];
  analysts: AnalystSignal[];
  evidence: EvidenceItem[];
  risks: string[];
  sources: SourceStatus[];
  setup: string[];
  headlines: MarketCard['headlines'];
  aiAnalysis: MarketCard['aiAnalysis'];
}

function finalize(input: FinalizeInput): MarketCard {
  const analystWeights: Record<AnalystSignal['key'], number> = {
    technical: 30,
    positioning: 30,
    sentiment: 22,
    risk: 0
  };
  const active = input.analysts.filter((item) => item.confidence > 0 && item.key !== 'risk');
  const effectiveWeight = active.reduce(
    (sum, item) => sum + analystWeights[item.key] * item.confidence / 100,
    0
  );
  const score = effectiveWeight
    ? Math.round(active.reduce(
      (sum, item) => sum + item.score * analystWeights[item.key] * item.confidence / 100,
      0
    ) / effectiveWeight)
    : 0;
  const rawVerdict = verdictFromScore(score);
  const unavailable = !input.coreAvailable;
  const verdict: Verdict = unavailable ? 'UNAVAILABLE' : rawVerdict;
  const agreement = active.length
    ? active.filter((item) => item.stance === rawVerdict || (rawVerdict === 'NEUTRAL' && Math.abs(item.score) < 25)).length / active.length
    : 0;
  const coverage = clamp(effectiveWeight / 82, 0, 1);
  const riskSignal = input.analysts.find((item) => item.key === 'risk' && item.confidence > 0);
  const riskAdjustment = riskSignal
    ? clamp(riskSignal.score * riskSignal.confidence / 100 * 0.12, -12, 4)
    : -4;
  const confidence = unavailable
    ? 0
    : Math.round(clamp(28 + coverage * 42 + agreement * 15 + Math.abs(score) * 0.12 + riskAdjustment, 28, 89));
  const top = [...input.evidence].sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
  const lead = top[0];
  const support = top[1];
  const summary = unavailable
    ? 'Market-price evidence is missing, so news is shown for research but no directional call is issued.'
    : lead && support
      ? `${rawVerdict[0]}${rawVerdict.slice(1).toLowerCase()} composite at ${score}, led by ${lead.label.toLowerCase()} and ${support.label.toLowerCase()}.`
      : `${rawVerdict[0]}${rawVerdict.slice(1).toLowerCase()} composite at ${score}; signal coverage is still thin.`;
  const cases = buildCases(input.evidence);

  return {
    slug: input.slug,
    title: input.title,
    subtitle: input.subtitle,
    availability: unavailable ? 'unavailable' : availabilityFromSources(input.sources),
    verdict,
    headline: unavailable ? 'Waiting for grounded market data' : `${rawVerdict[0]}${rawVerdict.slice(1).toLowerCase()} multi-analyst read`,
    summary,
    horizon: input.horizon,
    lastUpdated: input.updatedAt,
    confidence,
    score,
    probabilities: probabilities(score, confidence, unavailable),
    priceLabel: input.slug === 'nifty' ? 'NIFTY 50' : 'BTC',
    price: input.price,
    priceChangePct: input.priceChangePct,
    metrics: input.metrics,
    analysts: input.analysts,
    evidence: top,
    headlines: input.headlines,
    aiAnalysis: input.aiAnalysis,
    bullCase: cases.bullCase,
    bearCase: cases.bearCase,
    risks: input.risks,
    sources: input.sources,
    setup: input.setup,
    trackRecord: { ...emptyTrackRecord }
  };
}

export function unavailableCard(
  slug: MarketCard['slug'],
  title: string,
  subtitle: string,
  reason: string,
  setup: string[],
  sources: SourceStatus[]
): MarketCard {
  return {
    slug,
    title,
    subtitle,
    availability: 'unavailable',
    verdict: 'UNAVAILABLE',
    headline: 'Live data unavailable',
    summary: reason,
    horizon: slug === 'nifty' ? 'Current session' : 'Next 4-8 hours',
    lastUpdated: null,
    confidence: 0,
    score: 0,
    probabilities: { bullish: 0, neutral: 100, bearish: 0 },
    priceLabel: slug === 'nifty' ? 'NIFTY 50' : 'BTC',
    price: null,
    priceChangePct: null,
    metrics: [],
    analysts: [],
    evidence: [],
    headlines: [],
    aiAnalysis: null,
    bullCase: ['No grounded bullish argument available.'],
    bearCase: ['No grounded bearish argument available.'],
    risks: ['The dashboard is intentionally refusing to guess without live evidence.'],
    sources,
    setup,
    trackRecord: { ...emptyTrackRecord }
  };
}

export function scoreNifty(snapshot: NiftySnapshot, sources: SourceStatus[]): MarketCard {
  const changePct = snapshot.spot != null && snapshot.previousClose
    ? ((snapshot.spot - snapshot.previousClose) / snapshot.previousClose) * 100
    : undefined;
  const vixChangePct = snapshot.vix != null && snapshot.vixPreviousClose
    ? ((snapshot.vix - snapshot.vixPreviousClose) / snapshot.vixPreviousClose) * 100
    : undefined;
  const oiSkew = snapshot.putOiChangePercent != null && snapshot.callOiChangePercent != null
    ? snapshot.putOiChangePercent - snapshot.callOiChangePercent
    : undefined;
  const maxPainDistancePct = snapshot.maxPain != null && snapshot.spot
    ? ((snapshot.maxPain - snapshot.spot) / snapshot.spot) * 100
    : undefined;
  const technicalParts = [
    changePct == null ? undefined : scaled(changePct, 1.1),
    snapshot.technical?.emaSpreadPct == null ? undefined : scaled(snapshot.technical.emaSpreadPct, 0.35),
    snapshot.technical?.rsi == null ? undefined : scaled(snapshot.technical.rsi - 50, 20),
    snapshot.technical?.macdHistogramPct == null ? undefined : scaled(snapshot.technical.macdHistogramPct, 0.12),
    snapshot.technical?.recentMomentumPct == null ? undefined : scaled(snapshot.technical.recentMomentumPct, 0.7)
  ];
  const positioningParts = [
    snapshot.pcr == null ? undefined : scaled(snapshot.pcr - 1, 0.25),
    oiSkew == null ? undefined : scaled(oiSkew, 14),
    maxPainDistancePct == null ? undefined : scaled(maxPainDistancePct, 1)
  ];
  const riskParts = [
    vixChangePct == null ? undefined : scaled(-vixChangePct, 7),
    snapshot.atmIv == null ? undefined : scaled(18 - snapshot.atmIv, 9),
    snapshot.atmSpreadPercent == null ? undefined : scaled(1.2 - snapshot.atmSpreadPercent, 1.2)
  ];
  const technicalScore = average(technicalParts);
  const positioningScore = average(positioningParts);
  const riskScore = average(riskParts);
  const technicalCount = technicalParts.filter((value) => value != null).length;
  const positioningCount = positioningParts.filter((value) => value != null).length;
  const riskCount = riskParts.filter((value) => value != null).length;

  const analysts = [
    analyst('technical', 'Technical Analyst', technicalScore == null ? undefined : technicalScore * 100, 25 + technicalCount * 14,
      technicalScore == null ? 'Intraday candles unavailable.' : `RSI/EMA/MACD and price momentum combine to ${Math.round(technicalScore * 100)}.`),
    analyst('positioning', 'Options Positioning', positioningScore == null ? undefined : positioningScore * 100, 25 + positioningCount * 20,
      positioningScore == null ? 'Option positioning unavailable.' : `PCR, OI build and max-pain pull combine to ${Math.round(positioningScore * 100)}.`),
    analyst('sentiment', 'News Sentiment', snapshot.sentiment?.score, snapshot.sentiment?.confidence ?? 0,
      snapshot.sentiment ? `${snapshot.sentiment.method === 'ai_blend' ? 'AI-enhanced: ' : ''}${snapshot.sentiment.positive} positive, ${snapshot.sentiment.negative} negative and ${snapshot.sentiment.neutral} neutral headlines.` : 'Recent headlines unavailable.'),
    analyst('risk', 'Risk Manager', riskScore == null ? undefined : riskScore * 100, 25 + riskCount * 20,
      riskScore == null ? 'Volatility and execution-risk inputs unavailable.' : `VIX, IV and spread conditions combine to ${Math.round(riskScore * 100)}.`)
  ];

  const items: EvidenceItem[] = [];
  if (changePct != null) items.push(evidence('spot', 'Spot move', pct(changePct), scaled(changePct, 1.1), 15, 'Current NIFTY move versus previous close.'));
  if (snapshot.technical?.emaSpreadPct != null) items.push(evidence('ema', 'EMA 12/26 trend', pct(snapshot.technical.emaSpreadPct), scaled(snapshot.technical.emaSpreadPct, 0.35), 12, 'Fast EMA above slow EMA supports trend continuation.'));
  if (snapshot.technical?.rsi != null) items.push(evidence('rsi', 'Intraday RSI', snapshot.technical.rsi.toFixed(1), scaled(snapshot.technical.rsi - 50, 20), 8, 'RSI above or below 50 measures directional momentum.'));
  if (snapshot.pcr != null) items.push(evidence('pcr', 'Put-call ratio', snapshot.pcr.toFixed(2), scaled(snapshot.pcr - 1, 0.25), 12, 'Moderate put dominance can indicate support; low PCR leans cautious.'));
  if (oiSkew != null) items.push(evidence('oi', 'Put vs call OI build', `${pct(snapshot.putOiChangePercent!)} vs ${pct(snapshot.callOiChangePercent!)}`, scaled(oiSkew, 14), 16, 'Relative put versus call OI addition measures positioning.'));
  if (maxPainDistancePct != null) items.push(evidence('max-pain', 'Max-pain pull', `${snapshot.maxPain!.toFixed(0)} (${pct(maxPainDistancePct)})`, scaled(maxPainDistancePct, 1), 8, 'Expiry positioning can pull spot toward max pain, but is not a standalone target.'));
  if (snapshot.sentiment) items.push(evidence('news', 'Headline sentiment', `${snapshot.sentiment.score >= 0 ? '+' : ''}${snapshot.sentiment.score}/100`, snapshot.sentiment.score / 100, 10, 'Recent headline tone is recency-weighted and used as context.'));

  const metrics: Metric[] = [
    changePct == null ? null : metric('Spot change', pct(changePct), 'vs previous close', toneFromSigned(changePct)),
    snapshot.technical?.rsi == null ? null : metric('RSI 14', snapshot.technical.rsi.toFixed(1), `${snapshot.technical.candleCount} intraday candles`, snapshot.technical.rsi >= 55 ? 'positive' : snapshot.technical.rsi <= 45 ? 'negative' : 'neutral'),
    vixChangePct == null || snapshot.vix == null ? null : metric('India VIX', `${snapshot.vix.toFixed(2)} (${pct(vixChangePct)})`, 'risk regime', toneFromSigned(vixChangePct, false)),
    snapshot.pcr == null ? null : metric('PCR', snapshot.pcr.toFixed(2), 'aggregate option-chain OI', snapshot.pcr >= 1 ? 'positive' : 'negative'),
    oiSkew == null ? null : metric('OI skew', pct(oiSkew), 'put OI minus call OI build', toneFromSigned(oiSkew)),
    snapshot.maxPain == null ? null : metric('Max pain', snapshot.maxPain.toFixed(0), 'nearest expiry magnet', maxPainDistancePct != null ? toneFromSigned(maxPainDistancePct) : 'neutral'),
    snapshot.atmIv == null ? null : metric('ATM IV', `${snapshot.atmIv.toFixed(2)}%`, 'nearest ATM options', snapshot.atmIv <= 18 ? 'positive' : snapshot.atmIv >= 22 ? 'negative' : 'neutral'),
    snapshot.sentiment == null ? null : metric('News pulse', `${snapshot.sentiment.score >= 0 ? '+' : ''}${snapshot.sentiment.score}`, `${snapshot.sentiment.method === 'ai_blend' ? 'AI blend' : 'rules'} · ${snapshot.sentiment.positive}/${snapshot.sentiment.negative} positive/negative`, toneFromSigned(snapshot.sentiment.score))
  ].filter((item): item is Metric => Boolean(item));

  const risks: string[] = [];
  if (snapshot.technical?.rsi != null && snapshot.technical.rsi > 72) risks.push('RSI is overextended; bullish momentum may be vulnerable to mean reversion.');
  if (snapshot.technical?.rsi != null && snapshot.technical.rsi < 28) risks.push('RSI is deeply oversold; chasing downside has reversal risk.');
  if (snapshot.atmIv != null && snapshot.atmIv > 20) risks.push('ATM IV is elevated, making long-option entries expensive.');
  if (snapshot.atmSpreadPercent != null && snapshot.atmSpreadPercent > 1.4) risks.push('ATM spreads are wide enough to damage entries and exits.');
  if (!snapshot.spot || !snapshot.technical) risks.push('Price or candle confirmation is missing; headlines alone cannot issue a NIFTY call.');
  if (!risks.length) risks.push('No critical risk veto is active, but intraday signals can reverse quickly.');

  return finalize({
    slug: 'nifty',
    title: 'Nifty 50 Research Desk',
    subtitle: 'Technical + options + news + risk consensus',
    horizon: 'Current session / next 2-4 hours',
    coreAvailable: Boolean(changePct != null || technicalScore != null || positioningScore != null),
    price: snapshot.spot ?? null,
    priceChangePct: changePct ?? null,
    updatedAt: snapshot.updatedAt ?? null,
    metrics,
    analysts,
    evidence: items,
    risks,
    sources,
    setup: snapshot.spot ? [] : ['Add the free UPSTOX_ANALYTICS_TOKEN to unlock NIFTY price, candles, VIX and options.'],
    headlines: snapshot.sentiment?.headlines ?? [],
    aiAnalysis: snapshot.aiAnalysis ?? null
  });
}

export function scoreCrypto(snapshot: CryptoSnapshot, sources: SourceStatus[]): MarketCard {
  const breadthPct = snapshot.breadthPositiveRatio == null ? undefined : snapshot.breadthPositiveRatio * 100;
  const spreadBlend = average([snapshot.btcSpreadPercent, snapshot.ethSpreadPercent]);
  const technicalParts = [
    snapshot.btcChangePct == null ? undefined : scaled(snapshot.btcChangePct, 3.5),
    snapshot.ethChangePct == null ? undefined : scaled(snapshot.ethChangePct, 4),
    snapshot.technical?.emaSpreadPct == null ? undefined : scaled(snapshot.technical.emaSpreadPct, 1.2),
    snapshot.technical?.rsi == null ? undefined : scaled(snapshot.technical.rsi - 50, 20),
    snapshot.technical?.macdHistogramPct == null ? undefined : scaled(snapshot.technical.macdHistogramPct, 0.3),
    snapshot.technical?.recentMomentumPct == null ? undefined : scaled(snapshot.technical.recentMomentumPct, 3)
  ];
  const positioningParts = [
    snapshot.marketCapChangePct == null ? undefined : scaled(snapshot.marketCapChangePct, 3),
    snapshot.breadthPositiveRatio == null ? undefined : scaled(snapshot.breadthPositiveRatio - 0.5, 0.35),
    snapshot.btcDominance == null ? undefined : scaled(57 - snapshot.btcDominance, 6)
  ];
  const sentimentParts = [
    snapshot.sentiment == null ? undefined : snapshot.sentiment.score / 100,
    snapshot.fearGreed == null ? undefined : scaled(snapshot.fearGreed - 50, 32)
  ];
  const riskParts = [
    spreadBlend == null ? undefined : scaled(0.1 - spreadBlend, 0.1),
    snapshot.technical?.volatilityPct == null ? undefined : scaled(1.2 - snapshot.technical.volatilityPct, 1.2)
  ];
  const technicalScore = average(technicalParts);
  const positioningScore = average(positioningParts);
  const sentimentScore = average(sentimentParts);
  const riskScore = average(riskParts);

  const analysts = [
    analyst('technical', 'Technical Analyst', technicalScore == null ? undefined : technicalScore * 100, 20 + technicalParts.filter((value) => value != null).length * 12,
      technicalScore == null ? 'BTC candles unavailable.' : `BTC/ETH momentum, RSI, EMA and MACD combine to ${Math.round(technicalScore * 100)}.`),
    analyst('positioning', 'Market Breadth', positioningScore == null ? undefined : positioningScore * 100, 25 + positioningParts.filter((value) => value != null).length * 20,
      positioningScore == null ? 'Broad-market participation unavailable.' : `Market cap, top-10 breadth and dominance combine to ${Math.round(positioningScore * 100)}.`),
    analyst('sentiment', 'Sentiment Analyst', sentimentScore == null ? undefined : sentimentScore * 100, average([snapshot.sentiment?.confidence, snapshot.fearGreed == null ? undefined : 75]) ?? 0,
      sentimentScore == null ? 'News and sentiment gauges unavailable.' : `${snapshot.sentiment?.method === 'ai_blend' ? 'AI headline meaning' : 'Headline tone'} and Fear & Greed combine to ${Math.round(sentimentScore * 100)}.`),
    analyst('risk', 'Risk Manager', riskScore == null ? undefined : riskScore * 100, 35 + riskParts.filter((value) => value != null).length * 22,
      riskScore == null ? 'Liquidity and volatility inputs unavailable.' : `Spread and realized-volatility conditions combine to ${Math.round(riskScore * 100)}.`)
  ];

  const items: EvidenceItem[] = [];
  if (snapshot.btcChangePct != null) items.push(evidence('btc', 'BTC 24h move', pct(snapshot.btcChangePct), scaled(snapshot.btcChangePct, 3.5), 14, 'Bitcoin remains the primary near-term market leader.'));
  if (snapshot.ethChangePct != null) items.push(evidence('eth', 'ETH 24h move', pct(snapshot.ethChangePct), scaled(snapshot.ethChangePct, 4), 10, 'Ethereum confirms whether risk appetite extends beyond BTC.'));
  if (snapshot.technical?.emaSpreadPct != null) items.push(evidence('ema', 'BTC EMA 12/26', pct(snapshot.technical.emaSpreadPct), scaled(snapshot.technical.emaSpreadPct, 1.2), 12, 'Fast-versus-slow EMA measures the hourly trend.'));
  if (snapshot.technical?.rsi != null) items.push(evidence('rsi', 'BTC hourly RSI', snapshot.technical.rsi.toFixed(1), scaled(snapshot.technical.rsi - 50, 20), 8, 'Hourly RSI measures current momentum regime.'));
  if (snapshot.marketCapChangePct != null) items.push(evidence('mcap', 'Total market cap', pct(snapshot.marketCapChangePct), scaled(snapshot.marketCapChangePct, 3), 14, 'Total market-cap change is a broad trend check.'));
  if (breadthPct != null) items.push(evidence('breadth', 'Top-10 breadth', `${breadthPct.toFixed(0)}% green`, scaled(snapshot.breadthPositiveRatio! - 0.5, 0.35), 14, 'Breadth tests whether the move is widespread.'));
  const usesMoodProxy = snapshot.fearGreedLabel === 'Market data proxy';
  const moodLabel = usesMoodProxy ? 'Market mood' : 'Fear & Greed';
  if (snapshot.fearGreed != null) items.push(evidence('fear-greed', moodLabel, `${snapshot.fearGreed} · ${snapshot.fearGreedLabel || 'Unknown'}`, scaled(snapshot.fearGreed - 50, 32), 10, usesMoodProxy ? 'A transparent composite of live momentum, breadth, technicals and news.' : 'A keyless market sentiment gauge; extremes also raise contrarian risk.'));
  if (snapshot.sentiment) items.push(evidence('news', 'Headline sentiment', `${snapshot.sentiment.score >= 0 ? '+' : ''}${snapshot.sentiment.score}/100`, snapshot.sentiment.score / 100, 10, 'Recent crypto headline tone is recency-weighted.'));

  const metrics: Metric[] = [
    snapshot.btcChangePct == null ? null : metric('BTC 24h', pct(snapshot.btcChangePct), 'leader momentum', toneFromSigned(snapshot.btcChangePct)),
    snapshot.technical?.rsi == null ? null : metric('BTC RSI 14', snapshot.technical.rsi.toFixed(1), `${snapshot.technical.candleCount} hourly candles`, snapshot.technical.rsi >= 55 ? 'positive' : snapshot.technical.rsi <= 45 ? 'negative' : 'neutral'),
    snapshot.technical?.emaSpreadPct == null ? null : metric('EMA trend', pct(snapshot.technical.emaSpreadPct), '12 EMA vs 26 EMA', toneFromSigned(snapshot.technical.emaSpreadPct)),
    snapshot.marketCapChangePct == null ? null : metric('Market cap', pct(snapshot.marketCapChangePct), 'global 24h change', toneFromSigned(snapshot.marketCapChangePct)),
    breadthPct == null ? null : metric('Top-10 breadth', `${breadthPct.toFixed(0)}%`, 'large caps in green', breadthPct >= 60 ? 'positive' : breadthPct <= 40 ? 'negative' : 'neutral'),
    snapshot.fearGreed == null ? null : metric(moodLabel, String(snapshot.fearGreed), snapshot.fearGreedLabel || 'market mood', snapshot.fearGreed >= 55 ? 'positive' : snapshot.fearGreed <= 45 ? 'negative' : 'neutral'),
    snapshot.sentiment == null ? null : metric('News pulse', `${snapshot.sentiment.score >= 0 ? '+' : ''}${snapshot.sentiment.score}`, `${snapshot.sentiment.method === 'ai_blend' ? 'AI blend' : 'rules'} · ${snapshot.sentiment.positive}/${snapshot.sentiment.negative} positive/negative`, toneFromSigned(snapshot.sentiment.score)),
    spreadBlend == null ? null : metric('Execution spread', `${spreadBlend.toFixed(3)}%`, 'BTC/ETH average', spreadBlend <= 0.05 ? 'positive' : spreadBlend >= 0.15 ? 'negative' : 'neutral')
  ].filter((item): item is Metric => Boolean(item));

  const risks: string[] = [];
  if (snapshot.fearGreed != null && snapshot.fearGreed >= 80) risks.push('Extreme greed raises crowded-position and reversal risk.');
  if (snapshot.fearGreed != null && snapshot.fearGreed <= 20) risks.push('Extreme fear can accelerate liquidation, but also creates squeeze risk.');
  if (snapshot.technical?.rsi != null && snapshot.technical.rsi > 72) risks.push('Hourly RSI is overbought; chasing upside has mean-reversion risk.');
  if (snapshot.technical?.volatilityPct != null && snapshot.technical.volatilityPct > 1.5) risks.push('Hourly realized volatility is elevated, so probability bands are less stable.');
  if (!risks.length) risks.push('Crypto trades continuously; a fresh headline or liquidation cascade can invalidate this read.');

  return finalize({
    slug: 'crypto',
    title: 'Crypto Research Desk',
    subtitle: 'Technical + breadth + sentiment + risk consensus',
    horizon: 'Next 4-8 hours',
    coreAvailable: Boolean(snapshot.btcPrice != null || technicalScore != null),
    price: snapshot.btcPrice ?? null,
    priceChangePct: snapshot.btcChangePct ?? null,
    updatedAt: snapshot.updatedAt ?? null,
    metrics,
    analysts,
    evidence: items,
    risks,
    sources,
    setup: [],
    headlines: snapshot.sentiment?.headlines ?? [],
    aiAnalysis: snapshot.aiAnalysis ?? null
  });
}
