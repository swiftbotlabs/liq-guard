// Binance USDT-M futures TESTNET adapter. There is no mainnet path: the base URL is a constant and is checked.
import { DeskError, STEP, SYMBOLS, fmtPrice, fmtQty, type DeskData, type Venue, type VenuePosition } from '../../shared/desk';
import type { ActionSpec } from '../../shared/types';

export const TESTNET = 'https://testnet.binancefuture.com';
const TIMEOUT_MS = 4_000;

type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string, init?: RequestInit): Promise<any> {
  if (!url.startsWith(TESTNET + '/')) throw new DeskError('not_testnet', 'refusing a non-testnet URL', 500);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await f(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    if (text.length > 2_000_000) throw new DeskError('venue_error', 'venue response too large', 502);
    let body: any;
    try { body = JSON.parse(text); } catch { throw new DeskError('venue_error', `venue HTTP ${r.status} (not JSON)`, 502); }
    if (!r.ok) {
      const msg = typeof body?.msg === 'string' ? body.msg.slice(0, 160) : `HTTP ${r.status}`;
      throw new DeskError('venue_error', `testnet: ${msg}`, 502);
    }
    return body;
  } catch (e) {
    if (e instanceof DeskError) throw e;
    throw new DeskError('venue_unreachable', 'testnet unreachable', 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Public mark prices (no key). Throws on any failure or bad number. */
export async function fetchMarks(f: Fetch, symbols: string[]): Promise<Record<string, number>> {
  const want = symbols.filter((s) => (SYMBOLS as readonly string[]).includes(s));
  const out: Record<string, number> = {};
  await Promise.all(want.map(async (s) => {
    const j = await getJson(f, `${TESTNET}/fapi/v1/premiumIndex?symbol=${s}`);
    const m = parseFloat(j?.markPrice);
    if (!(m > 0) || !Number.isFinite(m)) throw new DeskError('bad_mark', `bad mark for ${s}`, 502);
    out[s] = m;
  }));
  return out;
}

/** Small time-based cache so a 2 s poll from the glasses doesn't hammer the price source. */
export function cachedFrom(get: (symbols: string[]) => Promise<Record<string, number>>, ttlMs = 1_000): (symbols: string[]) => Promise<Record<string, number>> {
  let at = 0;
  let key = '';
  let val: Record<string, number> = {};
  return async (symbols) => {
    const k = [...symbols].sort().join(',');
    if (k === key && Date.now() - at < ttlMs) return val;
    val = await get(symbols);
    key = k;
    at = Date.now();
    return val;
  };
}

export const cachedMarks = (f: Fetch, ttlMs = 1_000) => cachedFrom((s) => fetchMarks(f, s), ttlMs);

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface LiveCreds { key: string; secret: string }

/** Signed request. The key and secret never leave this function; errors carry only Binance's code/msg. */
export async function signed(f: Fetch, creds: LiveCreds, method: 'GET' | 'POST', path: string, params: Record<string, string>): Promise<any> {
  const q = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(Date.now()) }).toString();
  const sig = await hmacHex(creds.secret, q);
  const url = `${TESTNET}${path}?${q}&signature=${sig}`;
  return getJson(f, url, { method, headers: { 'X-MBX-APIKEY': creds.key } });
}

export function qtyString(symbol: string, q: number): string {
  const step = STEP[symbol] ?? 0.001;
  const dp = Math.max(0, Math.round(-Math.log10(step)));
  return (Math.floor(q / step + 1e-9) * step).toFixed(dp);
}

export function liveVenue(f: Fetch, creds: LiveCreds): Venue {
  const marks = cachedMarks(f);
  let posAt = 0;
  let posCache: VenuePosition[] = [];
  const positions = async (_d: DeskData, mk: Record<string, number>, fresh = false): Promise<VenuePosition[]> => {
    if (!fresh && Date.now() - posAt < 1_500) return posCache.map((p) => ({ ...p, mark: mk[p.symbol] ?? p.mark }));
    const rows: any[] = await signed(f, creds, 'GET', '/fapi/v2/positionRisk', {});
    const out: VenuePosition[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const amt = parseFloat(r.positionAmt);
      if (!amt || !(SYMBOLS as readonly string[]).includes(r.symbol)) continue;
      const entry = parseFloat(r.entryPrice);
      const lev = parseFloat(r.leverage) || 1;
      const iso = String(r.marginType).toLowerCase() === 'isolated';
      // isolatedWallet = the position's own margin; isolatedMargin includes unrealized PnL
      const margin = iso
        ? parseFloat(r.isolatedWallet ?? String(parseFloat(r.isolatedMargin) - parseFloat(r.unRealizedProfit || '0')))
        : (Math.abs(amt) * entry) / lev;
      out.push({
        symbol: r.symbol, side: amt > 0 ? 'LONG' : 'SHORT', qty: Math.abs(amt), entry, margin,
        liq: parseFloat(r.liquidationPrice), mark: mk[r.symbol] ?? parseFloat(r.markPrice),
      });
    }
    posCache = out;
    posAt = Date.now();
    return out;
  };
  return {
    mode: 'LIVE',
    label: 'TESTNET',
    marks,
    positions: (d, mk) => positions(d, mk),
    async available() {
      const rows: any[] = await signed(f, creds, 'GET', '/fapi/v2/balance', {});
      const usdt = (Array.isArray(rows) ? rows : []).find((r) => r.asset === 'USDT');
      const v = parseFloat(usdt?.availableBalance ?? '0');
      return Number.isFinite(v) ? v : 0;
    },
    async execute(d, a: ActionSpec, qty, mk, clientId) {
      const pos = (await positions(d, mk, true)).find((p) => p.symbol === a.symbol);
      if (!pos) throw new DeskError('no_position', 'no open position on testnet', 409);
      posAt = 0;
      if (a.kind === 'add_margin') {
        const r = await signed(f, creds, 'POST', '/fapi/v1/positionMargin', {
          symbol: a.symbol, amount: (Math.floor(a.amount! * 100) / 100).toFixed(2), type: '1', positionSide: 'BOTH',
        });
        if (r?.code !== 200) throw new DeskError('venue_error', `testnet: ${String(r?.msg ?? 'margin change refused').slice(0, 120)}`, 502);
        return { ref: `margin+${a.amount}`, summary: `ADDED ${a.amount} USDT margin` };
      }
      const q = qtyString(a.symbol, Math.min(qty, pos.qty));
      if (!(parseFloat(q) > 0)) throw new DeskError('too_small', 'size rounds to zero', 400);
      const r = await signed(f, creds, 'POST', '/fapi/v1/order', {
        symbol: a.symbol, side: pos.side === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: q, reduceOnly: 'true',
        newClientOrderId: clientId.slice(0, 36), newOrderRespType: 'RESULT',
      });
      const px = parseFloat(r?.avgPrice) || mk[a.symbol];
      return {
        ref: `oid ${r?.orderId ?? '?'}`,
        summary: `${pos.side === 'LONG' ? 'SOLD' : 'BOUGHT'} ${fmtQty(parseFloat(r?.executedQty ?? q))} ${a.symbol.replace(/USDT$/, '')} @ ${fmtPrice(px, a.symbol)}`,
      };
    },
  };
}
