import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from './modelConfig.js';
import { classifyOutcome, isCorrect, returnPct } from './outcomes.js';

const thresholds = { upPct: 0.2, downPct: 0.2 };

describe('outcome classification', () => {
  it.each([
    [0.21, 'UP'],
    [0.2, 'NEUTRAL'],
    [0, 'NEUTRAL'],
    [-0.2, 'NEUTRAL'],
    [-0.21, 'DOWN'],
    [0.35, 'UP'],
    [-0.35, 'DOWN'],
    [0.25, 'UP']
  ] as const)('classifies %s%% as %s', (move, expected) => {
    expect(classifyOutcome(move, thresholds)).toBe(expected);
  });

  it('gives every return exactly one class (no overlap)', () => {
    for (let move = -1; move <= 1; move += 0.01) {
      const label = classifyOutcome(move, thresholds);
      const matches = [isCorrect('BULLISH', label), isCorrect('BEARISH', label), isCorrect('NEUTRAL', label)].filter(Boolean);
      expect(matches).toHaveLength(1);
    }
  });

  it('marks +0.25% correct only for a bullish call', () => {
    const label = classifyOutcome(0.25, thresholds);
    expect(isCorrect('BULLISH', label)).toBe(true);
    expect(isCorrect('NEUTRAL', label)).toBe(false);
  });

  it('supports asymmetric, configurable thresholds', () => {
    expect(classifyOutcome(0.3, { upPct: 0.35, downPct: 0.1 })).toBe('NEUTRAL');
    expect(classifyOutcome(-0.15, { upPct: 0.35, downPct: 0.1 })).toBe('DOWN');
  });

  it('reads threshold overrides from the environment', () => {
    process.env.CRYPTO_OUTCOME_UP_PCT = '0.5';
    process.env.CRYPTO_OUTCOME_DOWN_PCT = 'not-a-number';
    const config = loadConfig();
    expect(config.outcome.crypto.upPct).toBe(0.5);
    expect(config.outcome.crypto.downPct).toBe(DEFAULT_CONFIG.outcome.crypto.downPct);
    delete process.env.CRYPTO_OUTCOME_UP_PCT;
    delete process.env.CRYPTO_OUTCOME_DOWN_PCT;
  });

  it('rejects invalid prices and returns', () => {
    expect(() => classifyOutcome(Number.NaN, thresholds)).toThrow();
    expect(() => returnPct(0, 10)).toThrow();
    expect(returnPct(100, 101)).toBeCloseTo(1, 10);
  });
});
