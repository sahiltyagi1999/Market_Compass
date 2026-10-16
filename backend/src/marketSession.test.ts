import { describe, expect, it } from 'vitest';
import { intradayTarget, istDateKey, istTime, marketStatus, nextTradingDay, previousTradingDay } from './marketSession.js';

const ist = (date: string, hhmm: string) => {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return istTime(date, hours * 60 + minutes);
};

describe('NSE session calendar (Asia/Kolkata)', () => {
  it('opens at 09:15 and closes at 15:30 IST', () => {
    expect(marketStatus(ist('2026-10-12', '09:14')).state).toBe('pre-open');
    expect(marketStatus(ist('2026-10-12', '09:15')).state).toBe('open');
    expect(marketStatus(ist('2026-10-12', '15:29')).state).toBe('open');
    expect(marketStatus(ist('2026-10-12', '15:30')).state).toBe('post-close');
  });

  it('treats weekends and official holidays as closed', () => {
    const saturday = marketStatus(ist('2026-10-10', '11:00'));
    expect(saturday.state).toBe('weekend');
    expect(saturday.nextOpenAt).toBe(ist('2026-10-12', '09:15'));
    const dussehra = marketStatus(ist('2026-10-20', '11:00'));
    expect(dussehra.state).toBe('holiday');
    expect(dussehra.holidayName).toBe('Dussehra');
    expect(dussehra.nextOpenAt).toBe(ist('2026-10-21', '09:15'));
  });

  it('skips holidays when moving between trading days', () => {
    expect(nextTradingDay('2026-10-19')).toBe('2026-10-21');
    expect(previousTradingDay('2026-10-21')).toBe('2026-10-19');
    expect(previousTradingDay('2026-10-12')).toBe('2026-10-09');
    expect(nextTradingDay('2026-12-24')).toBe('2026-12-28');
  });

  it('converts instants to IST dates across midnight UTC', () => {
    expect(istDateKey(Date.parse('2026-10-11T19:00:00Z'))).toBe('2026-10-12');
  });

  it('flags years without a verified holiday calendar', () => {
    expect(marketStatus(ist('2027-03-01', '11:00')).calendarVerified).toBe(false);
    const target = intradayTarget(ist('2027-03-01', '11:00'), 180, 60);
    expect(target.ok).toBe(false);
  });
});

describe('intraday prediction targets', () => {
  it('uses the full horizon when the session allows it', () => {
    const target = intradayTarget(ist('2026-10-12', '10:30'), 180, 60);
    expect(target).toMatchObject({ ok: true, horizonMinutes: 180, truncatedAtClose: false });
    if (target.ok) expect(target.targetAt).toBe(ist('2026-10-12', '13:30'));
  });

  it('caps the target at the close instead of rolling into the next day', () => {
    const target = intradayTarget(ist('2026-10-12', '14:00'), 180, 60);
    expect(target).toMatchObject({ ok: true, horizonMinutes: 90, truncatedAtClose: true });
    if (target.ok) expect(target.targetAt).toBe(ist('2026-10-12', '15:30'));
  });

  it('skips when less than the minimum horizon remains', () => {
    const target = intradayTarget(ist('2026-10-12', '14:45'), 180, 60);
    expect(target).toMatchObject({ ok: false, reason: 'too-close-to-close' });
  });

  it('skips outside the session, on weekends and on holidays', () => {
    expect(intradayTarget(ist('2026-10-12', '08:00'), 180, 60)).toMatchObject({ ok: false, reason: 'market-closed' });
    expect(intradayTarget(ist('2026-10-10', '11:00'), 180, 60)).toMatchObject({ ok: false, reason: 'market-closed' });
    expect(intradayTarget(ist('2026-10-20', '11:00'), 180, 60)).toMatchObject({ ok: false, reason: 'market-closed' });
  });
});
