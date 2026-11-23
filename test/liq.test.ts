import { describe, expect, it } from 'vitest';
import { BRACKETS, bracketFor, liqDistance, liqPrice, marginForDistance, unrealizedPnl } from '../shared/liq';

describe('brackets', () => {
  it('derives maintenance amounts consistently', () => {
    const b = BRACKETS.BTCUSDT;
    expect(b[0].cum).toBe(0);
    expect(b[1].cum).toBeCloseTo(50, 6);
    expect(b[2].cum).toBeCloseTo(950, 6);
    expect(b[3].cum).toBeCloseTo(11_450, 6);
  });
  it('picks the tier by notional', () => {
    expect(bracketFor('BTCUSDT', 49_999).mmr).toBe(0.004);
    expect(bracketFor('BTCUSDT', 50_000).mmr).toBe(0.005);
    expect(bracketFor('BTCUSDT', 5e12).mmr).toBe(0.5);
    expect(() => bracketFor('DOGEUSDT', 1)).toThrow();
  });
});

describe('isolated liquidation price (Binance formula)', () => {
  it('long 1 BTC @10,000 with 1,000 margin -> 9,036.14', () => {
    expect(liqPrice({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 10_000, margin: 1_000 })).toBeCloseTo(9036.1446, 3);
  });
  it('short 1 BTC @10,000 with 1,000 margin -> 10,956.18', () => {
    expect(liqPrice({ symbol: 'BTCUSDT', side: 'SHORT', qty: 1, entry: 10_000, margin: 1_000 })).toBeCloseTo(11000 / 1.004, 3);
  });
  it('uses cum in a higher tier', () => {
    // notional 100k -> tier 2 (mmr .005, cum 50)
    const lp = liqPrice({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: 100_000, margin: 10_000 });
    expect(lp).toBeCloseTo((10_000 + 50 - 100_000) / (0.005 - 1), 4);
  });
  it('adding margin moves a long liq down, a short liq up', () => {
    const p = { symbol: 'BTCUSDT', side: 'LONG' as const, qty: 0.2, entry: 65_000, margin: 1_300 };
    expect(liqPrice({ ...p, margin: 1_600 })).toBeLessThan(liqPrice(p));
    const s = { ...p, side: 'SHORT' as const };
    expect(liqPrice({ ...s, margin: 1_600 })).toBeGreaterThan(liqPrice(s));
  });
  it('reducing an isolated position pro rata keeps liq ~unchanged (cum=0 tier)', () => {
    const p = { symbol: 'BTCUSDT', side: 'LONG' as const, qty: 0.2, entry: 65_000, margin: 1_300 };
    expect(liqPrice({ ...p, qty: 0.1, margin: 650 })).toBeCloseTo(liqPrice(p), 6);
  });
  it('rejects nonsense input', () => {
    expect(liqPrice({ symbol: 'BTCUSDT', side: 'LONG', qty: 0, entry: 1, margin: 1 })).toBeNaN();
    expect(liqPrice({ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entry: -1, margin: 1 })).toBeNaN();
  });
});

describe('distance, pnl, margin solver', () => {
  it('distance is positive while safe for both sides', () => {
    expect(liqDistance('LONG', 100, 90)).toBeCloseTo(0.1);
    expect(liqDistance('SHORT', 100, 110)).toBeCloseTo(0.1);
    expect(liqDistance('LONG', 100, 101)).toBeLessThan(0);
  });
  it('pnl sign', () => {
    expect(unrealizedPnl({ side: 'LONG', qty: 2, entry: 100 }, 110)).toBe(20);
    expect(unrealizedPnl({ side: 'SHORT', qty: 2, entry: 100 }, 110)).toBe(-20);
  });
  it('marginForDistance hits the target distance exactly', () => {
    const p = { symbol: 'BTCUSDT', side: 'LONG' as const, qty: 0.2, entry: 65_000, margin: 1_300 };
    const mark = 61_500;
    const add = marginForDistance(p, mark, 0.1);
    expect(add).toBeGreaterThan(0);
    expect(liqDistance('LONG', mark, liqPrice({ ...p, margin: p.margin + add }))).toBeCloseTo(0.1, 9);
    const s = { ...p, side: 'SHORT' as const, entry: 60_000, margin: 1_200 };
    const add2 = marginForDistance(s, 63_000, 0.1);
    expect(liqDistance('SHORT', 63_000, liqPrice({ ...s, margin: s.margin + add2 }))).toBeCloseTo(0.1, 9);
    expect(marginForDistance(p, 80_000, 0.1)).toBe(0); // already safe
  });
});
