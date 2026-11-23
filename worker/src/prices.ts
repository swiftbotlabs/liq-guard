// Mark-price chain for SIM mode. Order: price relay (if configured) -> Binance futures testnet directly -> simulated prices.
// A real source that fails is skipped for RETRY_MS, so one blocked route never slows every poll. If every real source fails,
// prices continue as a labelled simulation anchored at the last real mark, so the demo never breaks and never pretends.
import { fetchMarks, TESTNET } from './binance';
import { DeskError, SYMBOLS } from '../../shared/desk';

type Fetch = typeof fetch;
export type PriceSource = 'testnet' | 'relay' | 'simulated';

const RETRY_MS = 30_000;
const TIMEOUT_MS = 4_000;
// Used only when no real mark has ever been seen in this Worker instance. Labelled "simulated" on screen and in /api/state.
export const REF_MARKS: Record<string, number> = { BTCUSDT: 63_000, ETHUSDT: 1_780 };

/** Smooth, stateless drift around an anchor (about +-0.6 %), so simulated prices still move like a market. */
export function simulatedMark(anchor: number, t: number, symbol: string): number {
  const ph = symbol.length * 1.7;
  const w = 0.004 * Math.sin(t / 37_000 + ph) + 0.0015 * Math.sin(t / 11_000 + ph * 2) + 0.0006 * Math.sin(t / 3_100 + ph);
  return anchor * (1 + w);
}

async function relayMarks(f: Fetch, base: string, token: string, symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(symbols.map(async (s) => {
    const url = `${base}/fapi/v1/premiumIndex?symbol=${s}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await f(url, { headers: { 'x-relay-token': token }, signal: ctrl.signal });
      if (!r.ok) throw new DeskError('venue_error', `relay HTTP ${r.status}`, 502);
      const m = parseFloat((await r.json() as any)?.markPrice);
      if (!(m > 0) || !Number.isFinite(m)) throw new DeskError('bad_mark', `bad mark for ${s}`, 502);
      out[s] = m;
    } catch (e) {
      if (e instanceof DeskError) throw e;
      throw new DeskError('venue_unreachable', 'relay unreachable', 502);
    } finally { clearTimeout(timer); }
  }));
  return out;
}

export interface PriceChainOpts { fetch: Fetch; relayUrl?: string; relayToken?: string; now?: () => number; directOff?: boolean }

export function priceChain(o: PriceChainOpts) {
  const now = o.now ?? Date.now;
  const relayUrl = (o.relayUrl ?? '').replace(/\/+$/, '');
  if (relayUrl && !/^https?:\/\/[a-z0-9.:-]+$/i.test(relayUrl)) throw new Error('PRICE_RELAY_URL must be a bare origin');
  const routes: { name: PriceSource; get: (s: string[]) => Promise<Record<string, number>>; downUntil: number }[] = [];
  if (relayUrl && o.relayToken) routes.push({ name: 'relay', get: (s) => relayMarks(o.fetch, relayUrl, o.relayToken!, s), downUntil: 0 });
  if (!o.directOff) routes.push({ name: 'testnet', get: (s) => fetchMarks(o.fetch, s), downUntil: 0 });
  const anchor: Record<string, number> = {};
  let source: PriceSource = 'simulated';
  let lastError = '';

  async function marks(symbols: string[]): Promise<Record<string, number>> {
    const want = symbols.filter((s) => (SYMBOLS as readonly string[]).includes(s));
    const t = now();
    for (const r of routes) {
      if (r.downUntil > t) continue;
      try {
        const m = await r.get(want);
        for (const [k, v] of Object.entries(m)) anchor[k] = v;
        source = r.name;
        return m;
      } catch (e) {
        r.downUntil = t + RETRY_MS;
        lastError = e instanceof DeskError ? e.message : 'unreachable';
      }
    }
    source = 'simulated';
    const out: Record<string, number> = {};
    for (const s of want) out[s] = simulatedMark(anchor[s] ?? REF_MARKS[s], t, s);
    return out;
  }
  return { marks, source: () => source, lastError: () => lastError, testnetOrigin: TESTNET };
}
