import type { MarketCard, MarketEvent } from './types.js';

interface CalendarEntry {
  name: string;
  market: MarketEvent['market'];
  /** ISO instant (UTC). */
  at: string;
  timezone: string;
  source: string;
  sourceUrl: string;
  /** False when the publisher states the date but not the time. */
  timeVerified: boolean;
}

const VERIFIED_ON = '2026-10-10';
const FOMC_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const BLS_URL = 'https://www.bls.gov/schedule/2026/home.htm';
const RBI_URL = 'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=62422';

// FOMC statements are released at 2:00 p.m. ET on the second meeting day.
// US daylight time in 2026 runs 8 Mar - 1 Nov (EDT = UTC-4, otherwise UTC-5).
const fomc = (date: string, utcHour: number): CalendarEntry => ({
  name: 'FOMC policy statement',
  market: 'both',
  at: `${date}T${String(utcHour).padStart(2, '0')}:00:00Z`,
  timezone: 'America/New_York',
  source: 'Federal Reserve',
  sourceUrl: FOMC_URL,
  timeVerified: true
});

// CPI releases at 8:30 a.m. ET.
const cpi = (date: string, utcHour: number): CalendarEntry => ({
  name: 'US CPI release',
  market: 'both',
  at: `${date}T${String(utcHour).padStart(2, '0')}:30:00Z`,
  timezone: 'America/New_York',
  source: 'US Bureau of Labor Statistics',
  sourceUrl: BLS_URL,
  timeVerified: true
});

// RBI publishes MPC meeting dates; the decision is on the last day. RBI does
// not state a time in the schedule; 10:00 IST is customary but unverified.
const rbi = (date: string): CalendarEntry => ({
  name: 'RBI MPC policy decision',
  market: 'nifty',
  at: `${date}T04:30:00Z`,
  timezone: 'Asia/Kolkata',
  source: 'Reserve Bank of India',
  sourceUrl: RBI_URL,
  timeVerified: false
});

export const EVENT_CALENDAR: CalendarEntry[] = [
  fomc('2026-01-28', 19), fomc('2026-03-18', 18), fomc('2026-04-29', 18), fomc('2026-06-17', 18),
  fomc('2026-07-29', 18), fomc('2026-09-16', 18), fomc('2026-10-28', 18), fomc('2026-12-09', 19),
  cpi('2026-01-13', 13), cpi('2026-02-13', 13), cpi('2026-03-11', 12), cpi('2026-04-10', 12),
  cpi('2026-05-12', 12), cpi('2026-06-10', 12), cpi('2026-07-14', 12), cpi('2026-08-12', 12),
  cpi('2026-09-11', 12), cpi('2026-10-14', 12), cpi('2026-11-10', 13), cpi('2026-12-10', 13),
  rbi('2026-04-08'), rbi('2026-06-05'), rbi('2026-08-05'), rbi('2026-10-07'), rbi('2026-12-04'), rbi('2027-02-05')
];

/** Events relevant to a market from one hour ago to `windowHours` ahead. Never labelled bullish or bearish. */
export function upcomingEvents(market: MarketCard['slug'], now: number, windowHours = 7 * 24, calendar = EVENT_CALENDAR): MarketEvent[] {
  return calendar
    .filter((event) => event.market === 'both' || event.market === market)
    .map((event) => ({ event, time: Date.parse(event.at) }))
    .filter(({ time }) => time >= now - 60 * 60_000 && time <= now + windowHours * 60 * 60_000)
    .sort((left, right) => left.time - right.time)
    .map(({ event, time }) => ({
      name: event.timeVerified ? event.name : `${event.name} (time unconfirmed)`,
      market: event.market,
      scheduledAt: new Date(time).toISOString(),
      timezone: event.timezone,
      source: event.source,
      sourceUrl: event.sourceUrl,
      verifiedOn: VERIFIED_ON,
      minutesUntil: Math.round((time - now) / 60_000)
    }));
}

/** Adds events and a risk line when an event falls inside the forecast horizon. */
export function attachEvents(card: MarketCard, now: number) {
  card.events = upcomingEvents(card.slug, now);
  const inHorizon = card.events.filter((event) => event.minutesUntil >= -60 && event.minutesUntil <= card.horizonMinutes);
  if (inHorizon.length) {
    const names = inHorizon.map((event) => `${event.name} in ${event.minutesUntil >= 0 ? `${event.minutesUntil} min` : 'progress'}`).join('; ');
    card.risks = [`Scheduled event inside the forecast window (${names}); event volatility can override these signals.`, ...card.risks];
  }
  if (now > Date.parse('2026-12-31T23:59:59Z')) {
    card.risks.push('Event calendar covers 2026 only; update events.ts from official sources.');
  }
}
