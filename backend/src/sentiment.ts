import type { HeadlineSignal, SentimentSnapshot, Tone } from './types.js';

export interface RawHeadline {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
}

const positivePhrases = [
  'all time high', 'record high', 'rate cut', 'beats estimates', 'better than expected',
  'strong demand', 'net inflow', 'inflation cools', 'regulatory approval', 'buy rating',
  'vix falls', 'vix drops'
];
const negativePhrases = [
  'record low', 'rate hike', 'misses estimates', 'worse than expected', 'sell off',
  'net outflow', 'regulatory crackdown', 'security breach', 'profit warning', 'sell rating',
  'vix rises', 'vix surges', 'bears gain', 'bearish momentum', 'loses bullish momentum'
];
const positiveWords = new Set([
  'advance', 'approval', 'beat', 'beats', 'breakout', 'bullish', 'buy', 'climb', 'deal',
  'easing', 'expansion', 'gain', 'gains', 'growth', 'inflow', 'jump', 'jumps', 'launch',
  'optimism', 'outperform', 'profit', 'rally', 'rebound', 'recover', 'recovery', 'rise',
  'rises', 'robust', 'strong', 'surge', 'surges', 'upgrade', 'upside'
]);
const negativeWords = new Set([
  'ban', 'bearish', 'breakdown', 'crash', 'crackdown', 'cut', 'decline', 'declines', 'downgrade',
  'drop', 'drops', 'exploit', 'fall', 'falls', 'fraud', 'hack', 'hacked', 'inflation', 'lawsuit', 'liquidation',
  'loss', 'miss', 'misses', 'outflow', 'plunge', 'plunges', 'probe', 'recession', 'risk', 'sell', 'slump',
  'tariff', 'uncertainty', 'war', 'weak', 'weaker'
]);
const negations = new Set(['no', 'not', 'never', 'without']);

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function tone(score: number): Tone {
  if (score > 0.12) return 'positive';
  if (score < -0.12) return 'negative';
  return 'neutral';
}

export function scoreHeadline(title: string) {
  const normalized = title.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
  let raw = positivePhrases.reduce((sum, phrase) => sum + (normalized.includes(phrase) ? 2 : 0), 0);
  raw -= negativePhrases.reduce((sum, phrase) => sum + (normalized.includes(phrase) ? 2 : 0), 0);
  const words = normalized.split(/\s+/).filter(Boolean);
  words.forEach((word, index) => {
    const direction = positiveWords.has(word) ? 1 : negativeWords.has(word) ? -1 : 0;
    if (!direction) return;
    const negated = words.slice(Math.max(0, index - 3), index).some((candidate) => negations.has(candidate));
    raw += negated ? -direction : direction;
  });
  return clamp(raw / 4, -1, 1);
}

export function analyseHeadlines(rawHeadlines: RawHeadline[], now = Date.now()): SentimentSnapshot {
  const seen = new Set<string>();
  const headlines: HeadlineSignal[] = rawHeadlines
    .filter((item) => !/prediction for tomorrow|price prediction|daily horoscope/i.test(item.title))
    .filter((item) => {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 30)
    .map((item) => {
      const sentiment = scoreHeadline(item.title);
      return { ...item, sentiment, tone: tone(sentiment) };
    });

  let weightedScore = 0;
  let totalWeight = 0;
  for (const item of headlines) {
    const ageHours = Math.max(0, (now - new Date(item.publishedAt).getTime()) / 3_600_000);
    const recencyWeight = 0.35 + 0.65 * Math.exp(-ageHours / 24);
    weightedScore += item.sentiment * recencyWeight;
    totalWeight += recencyWeight;
  }

  const sourceCount = new Set(headlines.map((item) => item.source)).size;
  const confidence = Math.round(clamp(headlines.length * 3 + sourceCount * 4, 0, 82));
  return {
    score: totalWeight ? Math.round((weightedScore / totalWeight) * 100) : 0,
    deterministicScore: totalWeight ? Math.round((weightedScore / totalWeight) * 100) : 0,
    method: 'deterministic',
    confidence,
    positive: headlines.filter((item) => item.tone === 'positive').length,
    negative: headlines.filter((item) => item.tone === 'negative').length,
    neutral: headlines.filter((item) => item.tone === 'neutral').length,
    headlines: [...headlines]
      .sort((left, right) => Math.abs(right.sentiment) - Math.abs(left.sentiment))
      .slice(0, 8)
  };
}
