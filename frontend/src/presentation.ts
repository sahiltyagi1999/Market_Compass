import type { EvidenceItem, MarketCard, SourceStatus } from './types';

export function formatTime(value: string | null) {
  if (!value) return 'No live timestamp';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

export function formatClock(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

export function priceText(card: MarketCard) {
  if (card.price == null) return 'Not available';
  return card.slug === 'crypto'
    ? `$${card.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    : card.price.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export function signedPoints(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} pts`;
}

export function minutesLabel(minutes: number) {
  if (minutes < 0) return 'in progress';
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 48 * 60) return `in ${Math.round(minutes / 60)} h`;
  return `in ${Math.round(minutes / 1440)} days`;
}

export function ageLabel(source: SourceStatus) {
  if (source.ageSeconds == null) return '';
  if (source.ageSeconds < 90) return `${source.ageSeconds}s old`;
  if (source.ageSeconds < 5400) return `${Math.round(source.ageSeconds / 60)} min old`;
  return `${Math.round(source.ageSeconds / 3600)} h old`;
}

/** Required sources that are stale or failed: shown as warnings on the card. */
export function dataWarnings(card: MarketCard) {
  return card.sources.filter((source) => source.status === 'stale' || (!source.optional && source.status !== 'live'));
}

export function evidenceByRole(card: MarketCard) {
  const pick = (role: EvidenceItem['role']) => card.evidence.filter((item) => item.role === role);
  return { direction: pick('direction'), risk: pick('risk'), context: pick('context') };
}

export function pct(value: number | null | undefined, digits = 0) {
  return value == null ? 'n/a' : `${value.toFixed(digits)}%`;
}
