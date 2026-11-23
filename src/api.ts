// Thin client for the Liq Guard Worker. No keys here: the app holds only a random session id.
import type { ActionResult, AlertView, DeskState, Proposal } from '../shared/types';
import type { Intent } from '../shared/intents';

export interface TextReply { text: string; intent: Intent; proposal?: Proposal; alert?: AlertView }

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

export interface KV { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> }

export const browserKV: KV = {
  async get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  async set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: session lives in memory only */ } },
};

export function idemKey(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 'k' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class Api {
  private session = '';
  constructor(public base: string, private kv: KV = browserKV, private timeoutMs = 8_000) {
    this.base = base.replace(/\/+$/, '');
  }

  async init(pairCode?: string): Promise<string> {
    const saved = await this.kv.get('lg.session');
    if (saved && /^[a-f0-9]{32}$/.test(saved) && !pairCode) { this.session = saved; return saved; }
    const r = await this.req<{ session: string }>('POST', '/api/session', pairCode ? { pairCode } : {}, false);
    this.session = r.session;
    await this.kv.set('lg.session', r.session);
    return r.session;
  }

  private async req<T>(method: string, path: string, body?: unknown, auth = true, extra: Record<string, string> = {}, raw?: BodyInit, ct?: string): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { ...extra };
      if (auth) headers['X-Session'] = this.session;
      if (raw !== undefined) headers['Content-Type'] = ct ?? 'application/octet-stream';
      else if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(this.base + path, {
        method, headers, signal: ctrl.signal,
        body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(j.error ?? 'http_' + r.status, j.message ?? `HTTP ${r.status}`, r.status);
      return j as T;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('network', 'server unreachable', 0);
    } finally {
      clearTimeout(t);
    }
  }

  state() { return this.req<DeskState>('GET', '/api/state'); }
  propose(a: { kind: string; symbol: string; fraction?: number; amount?: number }) { return this.req<Proposal>('POST', '/api/action/propose', a); }
  confirm(token: string, key: string) { return this.req<ActionResult & { replay?: boolean }>('POST', '/api/action/confirm', { token }, true, { 'Idempotency-Key': key }); }
  cancel(token: string) { return this.req<{ cancelled: boolean }>('POST', '/api/action/cancel', { token }); }
  addAlert(symbol: string, price: number) { return this.req<AlertView>('POST', '/api/alerts', { symbol, price }); }
  intent(text: string, symbol?: string) { return this.req<TextReply>('POST', '/api/intent', { text, symbol }); }
  asr(pcm: Uint8Array, symbol?: string) {
    const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
    return this.req<TextReply>('POST', '/api/asr' + q, undefined, true, {}, pcm, 'application/octet-stream');
  }
  shock(pct: number, rampSec: number) { return this.req<{ ok: boolean }>('POST', '/api/sim/shock', { pct, rampSec }); }
  reset() { return this.req<{ ok: boolean }>('POST', '/api/sim/reset', {}); }
}
