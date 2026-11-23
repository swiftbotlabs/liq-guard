import { describe, expect, it } from 'vitest';
import { priceChain, simulatedMark, REF_MARKS } from '../worker/src/prices';
import { modeTag } from '../shared/screens';

const RELAY = 'https://relay.example';
type Mode = 'ok' | 'fail';
function fakeFetch(state: { relay: Mode; direct: Mode; calls: string[] }) {
  return (async (input: any, init?: any) => {
    const url = String(input);
    state.calls.push(url);
    const isRelay = url.startsWith(RELAY);
    const mode = isRelay ? state.relay : state.direct;
    if (isRelay && init?.headers?.['x-relay-token'] !== 'tok') return new Response('unauthorized', { status: 401 });
    if (mode === 'fail') return new Response('<html>403</html>', { status: 403 });
    const sym = new URL(url).searchParams.get('symbol');
    return new Response(JSON.stringify({ symbol: sym, markPrice: isRelay ? '60000.5' : '61000.5' }), { status: 200 });
  }) as typeof fetch;
}

describe('price chain', () => {
  it('uses the relay first', async () => {
    const st = { relay: 'ok' as Mode, direct: 'ok' as Mode, calls: [] as string[] };
    const c = priceChain({ fetch: fakeFetch(st), relayUrl: RELAY, relayToken: 'tok' });
    const m = await c.marks(['BTCUSDT']);
    expect(m.BTCUSDT).toBe(60000.5);
    expect(c.source()).toBe('relay');
    expect(st.calls.every((u) => u.startsWith(RELAY))).toBe(true);
  });

  it('falls back to the direct testnet when the relay fails', async () => {
    const st = { relay: 'fail' as Mode, direct: 'ok' as Mode, calls: [] as string[] };
    const c = priceChain({ fetch: fakeFetch(st), relayUrl: RELAY, relayToken: 'tok' });
    expect((await c.marks(['BTCUSDT'])).BTCUSDT).toBe(61000.5);
    expect(c.source()).toBe('testnet');
  });

  it('a wrong relay token is a failure, not a price', async () => {
    const st = { relay: 'ok' as Mode, direct: 'fail' as Mode, calls: [] as string[] };
    const c = priceChain({ fetch: fakeFetch(st), relayUrl: RELAY, relayToken: 'bad' });
    await c.marks(['BTCUSDT']);
    expect(c.source()).toBe('simulated');
  });

  it('every real route down -> labelled simulated prices anchored at the last real mark; real routes retried after 30 s', async () => {
    let t = 1_000_000;
    const st = { relay: 'ok' as Mode, direct: 'fail' as Mode, calls: [] as string[] };
    const c = priceChain({ fetch: fakeFetch(st), relayUrl: RELAY, relayToken: 'tok', now: () => t });
    await c.marks(['BTCUSDT', 'ETHUSDT']);
    st.relay = 'fail';
    t += 2_000;
    const sim = await c.marks(['BTCUSDT', 'ETHUSDT']);
    expect(c.source()).toBe('simulated');
    expect(Math.abs(sim.BTCUSDT / 60000.5 - 1)).toBeLessThan(0.007);
    // within the retry window no real route is called again
    const n = st.calls.length;
    t += 10_000;
    await c.marks(['BTCUSDT']);
    expect(st.calls.length).toBe(n);
    // after the window the relay is tried again and wins
    st.relay = 'ok';
    t += 30_000;
    expect((await c.marks(['BTCUSDT'])).BTCUSDT).toBe(60000.5);
    expect(c.source()).toBe('relay');
  });

  it('no real mark ever seen -> reference prices, still labelled simulated', async () => {
    const st = { relay: 'fail' as Mode, direct: 'fail' as Mode, calls: [] as string[] };
    const c = priceChain({ fetch: fakeFetch(st) });
    const m = await c.marks(['ETHUSDT', 'DOGEUSDT']);
    expect(Object.keys(m)).toEqual(['ETHUSDT']);
    expect(Math.abs(m.ETHUSDT / REF_MARKS.ETHUSDT - 1)).toBeLessThan(0.007);
    expect(c.source()).toBe('simulated');
  });

  it('simulated prices move but stay near the anchor', () => {
    const a = simulatedMark(100, 0, 'BTCUSDT');
    const b = simulatedMark(100, 20_000, 'BTCUSDT');
    expect(a).not.toBe(b);
    for (let t = 0; t < 600_000; t += 7_000) expect(Math.abs(simulatedMark(100, t, 'BTCUSDT') - 100)).toBeLessThan(0.61);
  });

  it('rejects a relay URL with a path (only a bare origin)', () => {
    expect(() => priceChain({ fetch: fakeFetch({ relay: 'ok', direct: 'ok', calls: [] }), relayUrl: 'https://x.example/evil?y=1', relayToken: 'tok' })).toThrow();
  });

  it('the glasses header says when prices are simulated', () => {
    const base: any = { mode: 'SIM', label: 'SIM', shockPct: 0 };
    expect(modeTag({ ...base, priceSource: 'relay' })).toBe('SIM');
    expect(modeTag({ ...base, priceSource: 'simulated' })).toBe('SIM sim px');
  });
});
