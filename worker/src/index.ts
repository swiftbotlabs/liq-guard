// Liq Guard backend: one Cloudflare Worker + one Durable Object per glasses session.
// SIM (default): a clearly labelled simulated isolated position marked to live Binance futures TESTNET prices.
// LIVE: the same desk against a Binance futures TESTNET account; the HMAC key lives only in Worker secrets.
import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_CAPS, Desk, DeskError, SYMBOLS, emptyDesk, randomToken, simVenue, type Caps, type DeskData, type Venue } from '../../shared/desk';
import { parseIntent, type Intent } from '../../shared/intents';
import type { ActionSpec } from '../../shared/types';
import { cachedFrom, liveVenue } from './binance';
import { priceChain } from './prices';
import { checkWav, pcmToWav, MAX_AUDIO_BYTES } from './audio';

export interface Env {
  DESK: DurableObjectNamespace<DeskDO>;
  LIMITER: DurableObjectNamespace<Limiter>;
  AI?: Ai;
  MODE?: string; // "SIM" (default) | "LIVE"
  PRICE_RELAY_URL?: string; // SIM: origin of the price relay (relay/), tried before the testnet itself
  PRICE_RELAY_TOKEN?: string; // secret
  PRICE_DIRECT?: string; // "0" = skip the direct testnet route (tests)
  DEMO_CONTROLS?: string; // "1" enables /api/sim/* (SIM only)
  BINANCE_TESTNET_KEY?: string; // secret, LIVE only
  BINANCE_TESTNET_SECRET?: string; // secret, LIVE only
  LIVE_PAIR_CODE?: string; // secret: required to open a LIVE session
  MAX_ORDER_NOTIONAL?: string;
  MAX_MARGIN_ADD?: string;
  MAX_MARGIN_DAY?: string;
  ASR_MODEL?: string;
}

const MAX_JSON = 4_096;
const SESSION_RE = /^[a-f0-9]{32}$/;
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Session, Idempotency-Key',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...CORS },
  });
}
const err = (code: string, message: string, status: number) => json({ error: code, message }, status);

export const modeOf = (env: Env): 'SIM' | 'LIVE' => (env.MODE === 'LIVE' ? 'LIVE' : 'SIM');

/** Read at most `max` bytes of a body, whatever Content-Length claims. */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const cl = Number(req.headers.get('content-length') ?? '0');
  if (cl > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

async function readJson(req: Request): Promise<any> {
  const b = await readCapped(req, MAX_JSON);
  if (!b) throw new DeskError('too_large', 'body too large', 413);
  if (!b.byteLength) return {};
  try { return JSON.parse(new TextDecoder().decode(b)); } catch { throw new DeskError('bad_json', 'invalid JSON', 400); }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function capsOf(env: Env): Caps {
  const n = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);
  return {
    ...DEFAULT_CAPS,
    maxOrderNotional: n(env.MAX_ORDER_NOTIONAL, DEFAULT_CAPS.maxOrderNotional),
    maxMarginAdd: n(env.MAX_MARGIN_ADD, DEFAULT_CAPS.maxMarginAdd),
    maxMarginDay: n(env.MAX_MARGIN_DAY, DEFAULT_CAPS.maxMarginDay),
  };
}

// ------------------------------------------------------------------ entry
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    // The bare Worker URL is linked from the entry: answer it with a short pointer instead of a 404.
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD'))
      return json({ ok: true, service: 'Liq Guard Worker (SIM mode by default)', mode: modeOf(env), health: '/api/health', demo: 'https://apps.swiftbotlab.workers.dev/liq-guard-demo/', source: 'https://github.com/swiftbotlabs/liq-guard' });
    if (!url.pathname.startsWith('/api/')) return err('not_found', 'not found', 404);
    try {
      if (url.pathname === '/api/health') return json({ ok: true, mode: modeOf(env) });
      if (url.pathname === '/api/session' && req.method === 'POST') {
        const ip = req.headers.get('cf-connecting-ip') ?? 'local';
        const lim = env.LIMITER.get(env.LIMITER.idFromName('session:' + ip));
        if (!(await lim.allow('session', 20, 3_600_000))) return err('rate_limited', 'too many sessions from this network', 429);
        const body = await readJson(req);
        if (modeOf(env) === 'LIVE') {
          const code = typeof body.pairCode === 'string' ? body.pairCode : '';
          if (!env.LIVE_PAIR_CODE || !timingSafeEqual(code, env.LIVE_PAIR_CODE)) return err('pair_required', 'pairing code required for the testnet account', 403);
        }
        return json({ session: randomToken(), mode: modeOf(env) });
      }
      const session = req.headers.get('x-session') ?? '';
      if (!SESSION_RE.test(session)) return err('no_session', 'missing or bad X-Session', 401);
      if (url.pathname === '/api/asr') {
        // speech costs money per call: also limit per network, not only per (cheap) session
        const ip = req.headers.get('cf-connecting-ip') ?? 'local';
        const lim = env.LIMITER.get(env.LIMITER.idFromName('asr:' + ip));
        if (!(await lim.allow('asr', 30, 60_000))) return err('rate_limited', 'too many voice requests', 429);
      }
      // buffer the body here, capped, so the Durable Object only ever sees a complete, size-checked body
      let body: Uint8Array | undefined;
      if (req.method === 'POST') {
        const cap = url.pathname === '/api/asr' ? MAX_AUDIO_BYTES + 44 : MAX_JSON;
        const b = await readCapped(req, cap);
        if (!b) return err('too_large', url.pathname === '/api/asr' ? 'audio longer than 10 s' : 'body too large', 413);
        body = b;
      }
      const fwd = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: body && body.byteLength ? body : undefined,
      });
      const stub = env.DESK.get(env.DESK.idFromName(session));
      return await stub.fetch(fwd);
    } catch (e) {
      if (e instanceof DeskError) return err(e.code, e.message, e.status);
      return err('internal', 'internal error', 500);
    }
  },
} satisfies ExportedHandler<Env>;

// ------------------------------------------------------------------ rate limiter (fixed window, per key)
export class Limiter extends DurableObject<Env> {
  private w: Record<string, { start: number; n: number }> = {};
  async allow(bucket: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const s = this.w[bucket];
    if (!s || now - s.start >= windowMs) { this.w[bucket] = { start: now, n: 1 }; return true; }
    s.n += 1;
    return s.n <= limit;
  }
}

// ------------------------------------------------------------------ the desk, one per session
const LIMITS: Record<string, [number, number]> = { state: [90, 60_000], action: [20, 60_000], asr: [12, 60_000], other: [60, 60_000] };

export class DeskDO extends DurableObject<Env> {
  private d: DeskData = emptyDesk();
  private desk!: Desk;
  private win: Record<string, { start: number; n: number }> = {};

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<DeskData>('desk');
      if (saved) this.d = saved;
      this.desk = new Desk(this.d, this.venue(), Date.now, randomToken, capsOf(env));
    });
  }

  private venue(): Venue {
    const f = fetch.bind(globalThis);
    if (modeOf(this.env) === 'LIVE') {
      if (!this.env.BINANCE_TESTNET_KEY || !this.env.BINANCE_TESTNET_SECRET) {
        // fail closed: LIVE without a key never falls back to SIM silently
        return { ...simVenue(async () => { throw new DeskError('no_key', 'LIVE mode without testnet key', 503); }), mode: 'LIVE', label: 'TESTNET (no key)' };
      }
      return liveVenue(f, { key: this.env.BINANCE_TESTNET_KEY, secret: this.env.BINANCE_TESTNET_SECRET });
    }
    const chain = priceChain({ fetch: f, relayUrl: this.env.PRICE_RELAY_URL, relayToken: this.env.PRICE_RELAY_TOKEN, directOff: this.env.PRICE_DIRECT === '0' });
    return { ...simVenue(cachedFrom(chain.marks)), priceSource: chain.source };
  }

  private limited(kind: string): boolean {
    const [limit, windowMs] = LIMITS[kind] ?? LIMITS.other;
    const now = Date.now();
    const s = this.win[kind];
    if (!s || now - s.start >= windowMs) { this.win[kind] = { start: now, n: 1 }; return false; }
    s.n += 1;
    return s.n > limit;
  }

  private async save() { await this.ctx.storage.put('desk', this.d); }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    const kind = p === '/api/state' ? 'state' : p.startsWith('/api/action') ? 'action' : p === '/api/asr' ? 'asr' : 'other';
    if (this.limited(kind)) return err('rate_limited', 'slow down', 429);
    try {
      let out: unknown;
      if (p === '/api/state' && m === 'GET') out = await this.desk.state();
      else if (p === '/api/action/propose' && m === 'POST') out = await this.desk.propose(actionFrom(await readJson(req)));
      else if (p === '/api/action/confirm' && m === 'POST') {
        const b = await readJson(req);
        const idem = req.headers.get('idempotency-key') ?? b.idempotencyKey;
        out = await this.desk.confirm(String(b.token ?? ''), String(idem ?? ''));
      } else if (p === '/api/action/cancel' && m === 'POST') out = { cancelled: this.desk.cancel(String((await readJson(req)).token ?? '')) };
      else if (p === '/api/alerts' && m === 'GET') out = (await this.desk.state()).alerts;
      else if (p === '/api/alerts' && m === 'POST') {
        const b = await readJson(req);
        if (!this.d.lastMarksAt) await this.desk.refreshMarks();
        out = this.desk.addAlert(String(b.symbol ?? ''), Number(b.price));
      } else if (p.startsWith('/api/alerts/') && m === 'DELETE') out = { removed: this.desk.removeAlert(p.slice('/api/alerts/'.length).slice(0, 32)) };
      else if (p === '/api/intent' && m === 'POST') {
        const b = await readJson(req);
        out = await this.handleText(String(b.text ?? '').slice(0, 200), String(b.symbol ?? ''));
      } else if (p === '/api/asr' && m === 'POST') out = await this.asr(req, url.searchParams.get('symbol') ?? '');
      else if (p === '/api/sim/shock' && m === 'POST') {
        this.demoOnly();
        const b = await readJson(req);
        this.desk.setShock(Number(b.pct), Number(b.rampSec ?? 0) * 1000);
        out = { ok: true, shock: Number(b.pct) };
      } else if (p === '/api/sim/reset' && m === 'POST') {
        this.demoOnly();
        this.desk.resetSim();
        out = { ok: true };
      } else return err('not_found', 'not found', 404);
      await this.save();
      return json(out);
    } catch (e) {
      await this.save();
      if (e instanceof DeskError) return err(e.code, e.message, e.status);
      return err('internal', 'internal error', 500);
    }
  }

  private demoOnly() {
    if (modeOf(this.env) !== 'SIM' || this.env.DEMO_CONTROLS !== '1') throw new DeskError('disabled', 'demo controls are off', 403);
  }

  /** Text -> intent -> proposal (money), alert (set at once), or a UI hint. Voice never confirms. */
  async handleText(text: string, focus: string) {
    const intent: Intent = parseIntent(text);
    let symbol = 'symbol' in intent && intent.symbol ? intent.symbol : focus;
    if (!(SYMBOLS as readonly string[]).includes(symbol)) {
      const s = await this.desk.state();
      symbol = s.positions[0]?.symbol ?? 'BTCUSDT';
    }
    if (intent.type === 'reduce') return { text, intent, proposal: await this.desk.propose({ kind: 'reduce', symbol, fraction: intent.fraction }) };
    if (intent.type === 'close') return { text, intent, proposal: await this.desk.propose({ kind: 'close', symbol }) };
    if (intent.type === 'add_margin') return { text, intent, proposal: await this.desk.propose({ kind: 'add_margin', symbol, amount: intent.amount }) };
    if (intent.type === 'alert') {
      if (!this.d.lastMarksAt) await this.desk.refreshMarks();
      return { text, intent, alert: this.desk.addAlert(symbol, intent.price) };
    }
    return { text, intent };
  }

  /** 16 kHz mono PCM16 (raw or WAV) -> Workers AI Whisper -> handleText. Audio is never stored or logged. */
  async asr(req: Request, focus: string) {
    if (!this.env.AI) throw new DeskError('asr_unavailable', 'speech service not configured', 503);
    const body = await readCapped(req, MAX_AUDIO_BYTES + 44);
    if (!body) throw new DeskError('too_large', 'audio longer than 10 s', 413);
    const ct = (req.headers.get('content-type') ?? '').toLowerCase();
    const wav = ct.startsWith('audio/wav') || ct.startsWith('audio/x-wav') ? body : pcmToWav(body);
    const chk = checkWav(wav);
    if (!chk.ok) throw new DeskError('bad_audio', chk.reason, 400);
    let b64 = '';
    for (let i = 0; i < wav.length; i += 0x8000) b64 += String.fromCharCode(...wav.subarray(i, i + 0x8000));
    b64 = btoa(b64);
    const model = this.env.ASR_MODEL ?? '@cf/openai/whisper-large-v3-turbo';
    const r: any = await this.env.AI.run(model as any, { audio: b64, language: 'en' } as any);
    const text = String(r?.text ?? '').trim().slice(0, 200);
    return this.handleText(text, focus);
  }
}

function actionFrom(b: any): ActionSpec {
  const kind = String(b?.kind ?? '');
  const symbol = String(b?.symbol ?? '');
  if (kind === 'reduce') return { kind, symbol, fraction: Number(b.fraction) };
  if (kind === 'close') return { kind, symbol };
  if (kind === 'add_margin') return { kind, symbol, amount: Number(b.amount) };
  throw new DeskError('bad_kind', 'unknown action');
}
