import { describe, expect, it, beforeEach } from 'vitest';
import { Desk, DeskError, emptyDesk, simVenue, type DeskData } from '../shared/desk';
import { liqPrice } from '../shared/liq';

let t = 1_795_446_000_000;
let marks: Record<string, number> = {};
let fail = false;
let n = 0;
const now = () => t;
const rand = () => (++n).toString(16).padStart(32, 'a');
const venue = () => simVenue(async (syms) => {
  if (fail) throw new Error('testnet down');
  return Object.fromEntries(syms.map((s) => [s, marks[s]]));
});

let d: DeskData;
let desk: Desk;
beforeEach(() => {
  t = 1_795_446_000_000; n = 0; fail = false;
  marks = { BTCUSDT: 63_000, ETHUSDT: 3_000 };
  d = emptyDesk();
  desk = new Desk(d, venue(), now, rand);
});

const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as DeskError).code; } };

describe('SIM seed and state', () => {
  it('seeds a labelled BTC long and ETH short around the live mark, worst first', async () => {
    const s = await desk.state();
    expect(s.mode).toBe('SIM');
    expect(s.positions.map((p) => p.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    const btc = s.positions[0];
    expect(btc.side).toBe('LONG');
    expect(btc.leverage).toBe(8);
    expect(btc.liqDist).toBeGreaterThan(0.1);
    expect(btc.liqDist).toBeLessThan(0.11);
    expect(s.fired).toEqual([]); // starts calm
    expect(btc.pnl).toBeLessThan(0);
    expect(s.suggestions.BTCUSDT.at(-1)?.focus).toBe('ETHUSDT');
  });

  it('fails closed with no positions shown when prices are unavailable', async () => {
    await desk.state();
    fail = true;
    const s = await desk.state();
    expect(s.stale).toBe(true);
    expect(s.positions).toEqual([]);
    expect(await code(desk.propose({ kind: 'reduce', symbol: 'BTCUSDT', fraction: 0.5 }))).not.toBe('ok');
  });

  it('price move -> liq warn then danger alert, once each, with an add-margin default', async () => {
    await desk.state();
    marks.BTCUSDT = 63_000 * 0.97; t += 2_000;
    let s = await desk.state();
    expect(s.positions[0].risk).toBe('warn');
    expect(s.fired.map((a) => a.kind)).toEqual(['liq_warn']);
    marks.BTCUSDT = 63_000 * 0.94; t += 2_000;
    s = await desk.state();
    expect(s.positions[0].risk).toBe('danger');
    expect(s.fired.map((a) => a.kind)).toEqual(['liq_warn', 'liq_danger']);
    t += 2_000; s = await desk.state();
    expect(s.fired.length).toBe(2); // no repeat while still in danger
    expect(s.suggestions.BTCUSDT[0].action?.kind).toBe('add_margin');
  });

  it('SIM shock is a ramped, labelled offset on the live mark', async () => {
    await desk.state();
    desk.setShock(-0.04, 10_000);
    t += 5_000;
    const s = await desk.state();
    expect(s.shockPct).toBeCloseTo(-0.02, 6);
    expect(s.positions[0].mark).toBeCloseTo(63_000 * 0.98, 6);
    expect(() => desk.setShock(-0.5, 0)).toThrow();
  });
});

describe('price alerts', () => {
  it('alert at 60k fires once when crossed', async () => {
    await desk.state();
    const a = desk.addAlert('BTCUSDT', 60_000);
    expect(a.kind).toBe('price_below');
    marks.BTCUSDT = 60_100; t += 2_000;
    expect((await desk.state()).fired.filter((x) => x.kind === 'price_below')).toHaveLength(0);
    marks.BTCUSDT = 59_990; t += 2_000;
    const s = await desk.state();
    expect(s.fired.filter((x) => x.kind === 'price_below')).toHaveLength(1);
    expect(s.alerts.find((x) => x.id === a.id)?.armed).toBe(false);
  });
  it('validates and caps alerts', async () => {
    await desk.state();
    expect(() => desk.addAlert('DOGEUSDT', 1)).toThrow();
    expect(() => desk.addAlert('BTCUSDT', -5)).toThrow();
    for (let i = 0; i < 10; i++) desk.addAlert('BTCUSDT', 50_000 + i);
    expect(() => desk.addAlert('BTCUSDT', 49_000)).toThrow(/limit/);
  });
});

describe('propose -> confirm', () => {
  it('reduce half: token, then reduce-only execution, wallet credited, liq unchanged (isolated)', async () => {
    await desk.state();
    const before = d.sim.positions[0];
    const liqBefore = liqPrice(before);
    const pr = await desk.propose({ kind: 'reduce', symbol: 'BTCUSDT', fraction: 0.5 });
    expect(pr.title).toBe('Reduce BTC LONG by 50%?');
    expect(pr.lines[0]).toMatch(/sell 0.1 BTC .*reduce only/);
    const r = await desk.confirm(pr.token, 'idem-key-0001');
    expect(r.ok).toBe(true);
    expect(r.ref).toBe('SIM-0001');
    expect(d.sim.positions[0].qty).toBeCloseTo(0.1, 9);
    expect(liqPrice(d.sim.positions[0])).toBeCloseTo(liqBefore, 6);
    expect(d.sim.wallet).toBeLessThan(2_000 + d.sim.positions[0].margin * 2);
    expect(d.sim.wallet).toBeGreaterThan(2_000); // got margin back minus the realized loss
  });

  it('idempotency: same key replays without a second execution; reused key on another token conflicts', async () => {
    await desk.state();
    const pr = await desk.propose({ kind: 'reduce', symbol: 'BTCUSDT', fraction: 0.5 });
    const r1 = await desk.confirm(pr.token, 'idem-key-0002');
    const r2 = await desk.confirm(pr.token, 'idem-key-0002');
    expect(r2.replay).toBe(true);
    expect(r2.ref).toBe(r1.ref);
    expect(d.sim.positions[0].qty).toBeCloseTo(0.1, 9); // executed once
    const pr2 = await desk.propose({ kind: 'reduce', symbol: 'BTCUSDT', fraction: 0.5 });
    expect(await code(desk.confirm(pr2.token, 'idem-key-0002'))).toBe('idem_conflict');
    expect(await code(desk.confirm(pr.token, 'idem-key-0003'))).toBe('bad_token'); // token is single use
  });

  it('concurrent duplicate confirm runs once', async () => {
    await desk.state();
    const pr = await desk.propose({ kind: 'close', symbol: 'ETHUSDT' });
    const [a, b] = await Promise.allSettled([desk.confirm(pr.token, 'idem-key-0004'), desk.confirm(pr.token, 'idem-key-0004')]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(d.sim.positions.find((p) => p.symbol === 'ETHUSDT')).toBeUndefined();
  });

  it('expired token is refused', async () => {
    await desk.state();
    const pr = await desk.propose({ kind: 'reduce', symbol: 'BTCUSDT', fraction: 0.5 });
    t += 31_000;
    expect(await code(desk.confirm(pr.token, 'idem-key-0005'))).toBe('expired');
    expect(d.sim.positions[0].qty).toBe(0.2);
  });

  it('fails closed when prices vanish between propose and confirm, and burns the token', async () => {
    await desk.state();
    const pr = await desk.propose({ kind: 'reduce', symbol: 'BTCUSDT', fraction: 0.5 });
    fail = true;
    expect(await code(desk.confirm(pr.token, 'idem-key-0006'))).toBe('venue_error');
    fail = false;
    expect(await code(desk.confirm(pr.token, 'idem-key-0007'))).toBe('bad_token');
    expect(d.sim.positions[0].qty).toBe(0.2);
  });

  it('add margin moves liq away and respects caps and wallet', async () => {
    await desk.state();
    const liq0 = liqPrice(d.sim.positions[0]);
    const pr = await desk.propose({ kind: 'add_margin', symbol: 'BTCUSDT', amount: 200 });
    expect(pr.lines[0]).toMatch(/^liq .* -> /);
    await desk.confirm(pr.token, 'idem-key-0008');
    expect(liqPrice(d.sim.positions[0])).toBeLessThan(liq0);
    expect(d.sim.wallet).toBe(1_800);
    expect(await code(desk.propose({ kind: 'add_margin', symbol: 'BTCUSDT', amount: 5_000 }))).toBe('cap_margin');
    expect(await code(desk.propose({ kind: 'add_margin', symbol: 'BTCUSDT', amount: -1 }))).toBe('bad_amount');
  });

  it('positive control: the notional cap blocks a big order and lets it through when raised', async () => {
    const small = new Desk(d, venue(), now, rand, { maxOrderNotional: 5_000, maxMarginAdd: 1_000, maxMarginDay: 3_000, maxActionsDay: 50, maxAlerts: 10 });
    await small.state();
    expect(await code(small.propose({ kind: 'close', symbol: 'BTCUSDT' }))).toBe('cap_notional');
    const big = new Desk(d, venue(), now, rand, { maxOrderNotional: 50_000, maxMarginAdd: 1_000, maxMarginDay: 3_000, maxActionsDay: 50, maxAlerts: 10 });
    expect(await code(big.propose({ kind: 'close', symbol: 'BTCUSDT' }))).toBe('ok');
  });

  it('rejects anything that is not reduce-only or not on the allowlist', async () => {
    await desk.state();
    expect(await code(desk.propose({ kind: 'reduce', symbol: 'BTCUSDT', fraction: 1.5 }))).toBe('bad_fraction');
    expect(await code(desk.propose({ kind: 'reduce', symbol: 'BTCUSDT', fraction: 0 }))).toBe('bad_fraction');
    expect(await code(desk.propose({ kind: 'reduce', symbol: 'XRPUSDT', fraction: 0.5 }))).toBe('bad_symbol');
    expect(await code(desk.propose({ kind: 'alert', symbol: 'BTCUSDT', price: 1 }))).toBe('bad_kind');
    expect(await code(desk.propose({ kind: 'buy' as never, symbol: 'BTCUSDT' }))).toBe('bad_kind');
    expect(await code(desk.confirm('nope', 'short'))).toBe('bad_idempotency_key');
  });

  it('closed position then reduce -> no_position', async () => {
    await desk.state();
    const pr = await desk.propose({ kind: 'close', symbol: 'BTCUSDT' });
    const r = await desk.confirm(pr.token, 'idem-key-0009');
    expect(r.after).toMatch(/closed/);
    expect(await code(desk.propose({ kind: 'reduce', symbol: 'BTCUSDT', fraction: 0.5 }))).toBe('no_position');
  });
});
