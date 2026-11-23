// The desk: one trader's session state machine. Pure logic, no I/O except through the injected Venue.
// Runs inside a Durable Object in the Worker and directly in unit tests.

import { liqDistance, liqPrice, marginForDistance, unrealizedPnl, type IsoPosition, type Side } from './liq';
import type {
  ActionResult, ActionSpec, AlertView, DeskState, Mode, PositionView, Proposal, Suggestion, Trend,
} from './types';

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;
export const STEP: Record<string, number> = { BTCUSDT: 0.001, ETHUSDT: 0.001 };
export const ALERT_ROUND: Record<string, number> = { BTCUSDT: 500, ETHUSDT: 25 };
export const WARN = 0.1; // liq distance under 10% = warn
export const DANGER = 0.05; // under 5% = danger
export const TOKEN_TTL_MS = 30_000;
export const MAX_STALE_MS = 15_000;

export interface Caps {
  maxOrderNotional: number; // USDT per reduce/close order
  maxMarginAdd: number; // USDT per add-margin action
  maxMarginDay: number; // USDT per UTC day
  maxActionsDay: number;
  maxAlerts: number;
}
export const DEFAULT_CAPS: Caps = { maxOrderNotional: 25_000, maxMarginAdd: 1_000, maxMarginDay: 3_000, maxActionsDay: 50, maxAlerts: 10 };

export interface VenuePosition { symbol: string; side: Side; qty: number; entry: number; margin: number; liq: number; mark: number }

export interface Venue {
  mode: Mode;
  label: string;
  /** Where the last marks came from (SIM only): live testnet, testnet via relay, or labelled simulated prices. */
  priceSource?: () => 'testnet' | 'relay' | 'simulated';
  /** Mark prices for the symbols. Must throw on any failure (fail closed). */
  marks(symbols: string[]): Promise<Record<string, number>>;
  positions(d: DeskData, marks: Record<string, number>): Promise<VenuePosition[]>;
  available(d: DeskData): Promise<number>;
  execute(d: DeskData, a: ActionSpec, qty: number, marks: Record<string, number>, clientId: string): Promise<{ ref: string; summary: string }>;
}

export interface StoredAlert { id: string; symbol: string; kind: AlertView['kind']; level?: number; armed: boolean; firedAt?: number; createdAt: number }
interface StoredProposal { action: ActionSpec; expiresAt: number; used: boolean }
interface StoredResult { token: string; status: 'pending' | 'done' | 'failed'; result?: ActionResult; error?: string }

export interface DeskData {
  sim: {
    seeded: boolean;
    wallet: number;
    positions: IsoPosition[];
    shock: { from: number; to: number; t0: number; rampMs: number };
    seq: number;
  };
  alerts: StoredAlert[];
  liqRisk: Record<string, 'ok' | 'warn' | 'danger'>;
  proposals: Record<string, StoredProposal>;
  results: Record<string, StoredResult>;
  resultOrder: string[];
  hist: Record<string, [number, number][]>;
  day: { date: string; marginAdded: number; actions: number };
  lastMarks: Record<string, number>;
  lastMarksAt: number;
}

export function emptyDesk(): DeskData {
  return {
    sim: { seeded: false, wallet: 2_000, positions: [], shock: { from: 0, to: 0, t0: 0, rampMs: 0 }, seq: 0 },
    alerts: [], liqRisk: {}, proposals: {}, results: {}, resultOrder: [], hist: {},
    day: { date: '', marginAdded: 0, actions: 0 }, lastMarks: {}, lastMarksAt: 0,
  };
}

export class DeskError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

const baseOf = (s: string) => s.replace(/USDT$/, '');
export const fmtPrice = (p: number, symbol = 'BTCUSDT') =>
  Number.isFinite(p) ? p.toLocaleString('en-US', { maximumFractionDigits: symbol.startsWith('BTC') ? 0 : 2, minimumFractionDigits: 0 }) : '--';
export const fmtUsd = (v: number) => (v < 0 ? '-' : '+') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
export const fmtPct = (f: number, dp = 1) => (Number.isFinite(f) ? (f * 100).toFixed(dp) + '%' : '--');
export const fmtQty = (q: number) => q.toFixed(3).replace(/\.?0+$/, '') || '0';
const floorStep = (q: number, step: number) => Math.floor(q / step + 1e-9) * step;
const ceilTo = (v: number, step: number) => Math.ceil(v / step) * step;

function utcDate(now: number) { return new Date(now).toISOString().slice(0, 10); }

/** Ramped SIM shock: a labelled demo control that moves the simulated mark from `from` to `to` (fractions) over rampMs. */
export function shockAt(d: DeskData, now: number): number {
  const s = d.sim.shock;
  if (!s.rampMs) return s.to;
  const k = Math.min(1, Math.max(0, (now - s.t0) / s.rampMs));
  return s.from + (s.to - s.from) * k;
}

export class Desk {
  constructor(
    public d: DeskData,
    private venue: Venue,
    private now: () => number = Date.now,
    private rand: () => string = randomToken,
    private caps: Caps = DEFAULT_CAPS,
  ) {}

  get mode() { return this.venue.mode; }

  private rollDay() {
    const t = utcDate(this.now());
    if (this.d.day.date !== t) this.d.day = { date: t, marginAdded: 0, actions: 0 };
  }

  private symbolsInPlay(): string[] {
    const s = new Set<string>(SYMBOLS);
    for (const a of this.d.alerts) s.add(a.symbol);
    return [...s];
  }

  /** Fetch marks (fail closed), apply the SIM shock, record history. */
  async refreshMarks(): Promise<Record<string, number>> {
    const raw = await this.venue.marks(this.symbolsInPlay());
    const now = this.now();
    const shock = this.venue.mode === 'SIM' ? shockAt(this.d, now) : 0;
    const marks: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!(v > 0) || !Number.isFinite(v)) throw new DeskError('bad_mark', `bad mark for ${k}`, 502);
      marks[k] = v * (1 + shock);
    }
    for (const [k, v] of Object.entries(marks)) {
      const h = (this.d.hist[k] ??= []);
      if (!h.length || now - h[h.length - 1][0] >= 1_000) h.push([now, v]);
      while (h.length > 400 || (h.length && now - h[0][0] > 300_000)) h.shift();
    }
    this.d.lastMarks = marks;
    this.d.lastMarksAt = now;
    if (this.venue.mode === 'SIM' && !this.d.sim.seeded) this.seedSim(raw);
    return marks;
  }

  /** SIM seed: positions placed relative to the live testnet mark so the demo story is the same at any price. */
  seedSim(raw: Record<string, number>) {
    const btc = raw.BTCUSDT, eth = raw.ETHUSDT;
    const pos: IsoPosition[] = [];
    if (btc > 0) {
      // 8x long opened 2% above the current mark: starts calm (~10% from liquidation), slightly under water
      const entry = Math.round(btc * 1.02 * 10) / 10;
      pos.push({ symbol: 'BTCUSDT', side: 'LONG', qty: 0.2, entry, margin: Math.round((0.2 * entry) / 8 * 100) / 100 });
    }
    if (eth > 0) {
      const entry = Math.round(eth * 0.99 * 100) / 100;
      pos.push({ symbol: 'ETHUSDT', side: 'SHORT', qty: 3, entry, margin: Math.round((3 * entry) / 5 * 100) / 100 });
    }
    this.d.sim.positions = pos;
    this.d.sim.wallet = 2_000;
    this.d.sim.seeded = true;
  }

  private trendOf(symbol: string, mark: number): { trend: Trend; move1m: number } {
    const h = this.d.hist[symbol] ?? [];
    const now = this.now();
    let ref: number | undefined;
    for (const [t, v] of h) if (now - t <= 90_000 && now - t >= 20_000) { ref = v; break; }
    if (ref === undefined) return { trend: 'flat', move1m: 0 };
    const m = (mark - ref) / ref;
    const trend: Trend = m <= -0.003 ? 'down_fast' : m <= -0.0005 ? 'down' : m >= 0.003 ? 'up_fast' : m >= 0.0005 ? 'up' : 'flat';
    return { trend, move1m: m };
  }

  private view(p: VenuePosition): PositionView {
    const liq = p.liq;
    const dist = liqDistance(p.side, p.mark, liq);
    const pnl = unrealizedPnl(p, p.mark);
    const { trend, move1m } = this.trendOf(p.symbol, p.mark);
    return {
      symbol: p.symbol, base: baseOf(p.symbol), side: p.side, qty: p.qty, entry: p.entry, mark: p.mark,
      leverage: p.margin > 0 ? Math.round((p.qty * p.entry) / p.margin) : 0, margin: p.margin, liq, liqDist: dist,
      pnl, pnlPct: p.margin > 0 ? pnl / p.margin : 0, trend, move1m,
      risk: dist < DANGER ? 'danger' : dist < WARN ? 'warn' : 'ok',
    };
  }

  private evalAlerts(views: PositionView[], marks: Record<string, number>) {
    const now = this.now();
    for (const a of this.d.alerts) {
      if (!a.armed || a.level === undefined) continue;
      const m = marks[a.symbol];
      if (!(m > 0)) continue;
      if ((a.kind === 'price_below' && m <= a.level) || (a.kind === 'price_above' && m >= a.level)) {
        a.armed = false;
        a.firedAt = now;
      }
    }
    for (const v of views) {
      const prev = this.d.liqRisk[v.symbol] ?? 'ok';
      let next: 'ok' | 'warn' | 'danger' = v.risk;
      // hysteresis: step back down only after a 1% cushion
      if (prev === 'danger' && v.risk !== 'danger' && v.liqDist < DANGER + 0.01) next = 'danger';
      if (prev === 'warn' && v.risk === 'ok' && v.liqDist < WARN + 0.01) next = 'warn';
      const rank = { ok: 0, warn: 1, danger: 2 } as const;
      if (rank[next] > rank[prev]) {
        this.d.alerts.push({
          id: this.rand().slice(0, 12), symbol: v.symbol, kind: next === 'danger' ? 'liq_danger' : 'liq_warn',
          armed: false, firedAt: now, createdAt: now,
        });
      }
      this.d.liqRisk[v.symbol] = next;
    }
    // keep armed alerts plus fired ones from the last 10 minutes; bounded
    this.d.alerts = this.d.alerts.filter((a) => a.armed || (a.firedAt && now - a.firedAt < 600_000)).slice(-30);
  }

  private alertText(a: StoredAlert): string {
    const base = baseOf(a.symbol);
    switch (a.kind) {
      case 'price_below': return a.armed ? `${base} alert below ${fmtPrice(a.level!, a.symbol)}` : `${base} fell to ${fmtPrice(a.level!, a.symbol)}`;
      case 'price_above': return a.armed ? `${base} alert above ${fmtPrice(a.level!, a.symbol)}` : `${base} rose to ${fmtPrice(a.level!, a.symbol)}`;
      case 'liq_warn': return `${base} liquidation under ${fmtPct(WARN, 0)} away`;
      case 'liq_danger': return `${base} liquidation under ${fmtPct(DANGER, 0)} away`;
    }
  }

  suggestionsFor(v: PositionView, all: PositionView[], wallet: number): Suggestion[] {
    const out: Suggestion[] = [];
    const iso = { symbol: v.symbol, side: v.side, qty: v.qty, entry: v.entry, margin: v.margin };
    if (v.risk !== 'ok') {
      const target = v.risk === 'danger' ? 0.1 : 0.12;
      let amt = ceilTo(marginForDistance(iso, v.mark, target), 10);
      amt = Math.min(amt, this.caps.maxMarginAdd, Math.floor(wallet / 10) * 10);
      if (amt >= 10) out.push({ label: `add ${amt} margin`, action: { kind: 'add_margin', symbol: v.symbol, amount: amt } });
    }
    out.push({ label: v.pnl > 0 ? 'take half profit' : 'reduce half', action: { kind: 'reduce', symbol: v.symbol, fraction: 0.5 } });
    out.push({ label: 'close position', action: { kind: 'close', symbol: v.symbol } });
    const r = ALERT_ROUND[v.symbol] ?? 1;
    const mid = (v.mark + v.liq) / 2;
    const lvl = v.side === 'LONG' ? Math.ceil(mid / r) * r : Math.floor(mid / r) * r;
    const armed = this.d.alerts.some((a) => a.armed && a.symbol === v.symbol && a.level === lvl);
    if (lvl > 0 && Number.isFinite(lvl) && lvl !== v.mark && !armed) {
      const s: Suggestion = { label: `alert at ${fmtPrice(lvl, v.symbol)}`, action: { kind: 'alert', symbol: v.symbol, price: lvl } };
      // calm: the safe default is an alert (no money moves); at risk it comes after the fixes
      if (v.risk === 'ok') out.unshift(s); else out.push(s);
    }
    for (const o of all) if (o.symbol !== v.symbol) out.push({ label: `show ${o.base} ${o.side}`, focus: o.symbol });
    return out;
  }

  async state(): Promise<DeskState> {
    const label = this.venue.label;
    let marks: Record<string, number>;
    try {
      marks = await this.refreshMarks();
    } catch (e) {
      const age = this.now() - this.d.lastMarksAt;
      return {
        mode: this.venue.mode, label, shockPct: 0, positions: [], alerts: [], fired: [], suggestions: {}, wallet: 0,
        stale: true, updatedAt: this.d.lastMarksAt, error: `prices unavailable (${Math.round(age / 1000)} s)`,
      };
    }
    const vps = await this.venue.positions(this.d, marks);
    const views = vps.map((p) => this.view(p)).sort((a, b) => a.liqDist - b.liqDist);
    this.evalAlerts(views, marks);
    const wallet = await this.venue.available(this.d);
    const suggestions: Record<string, Suggestion[]> = {};
    for (const v of views) suggestions[v.symbol] = this.suggestionsFor(v, views, wallet);
    const alerts: AlertView[] = this.d.alerts.map((a) => ({
      id: a.id, symbol: a.symbol, kind: a.kind, level: a.level, armed: a.armed, firedAt: a.firedAt, text: this.alertText(a),
    }));
    return {
      mode: this.venue.mode, label, shockPct: this.venue.mode === 'SIM' ? shockAt(this.d, this.now()) : 0,
      positions: views, alerts, fired: alerts.filter((a) => !a.armed && a.firedAt), suggestions, wallet,
      stale: false, updatedAt: this.now(), priceSource: this.venue.priceSource?.(),
    };
  }

  // ---------- alerts (no money moves, so no confirm card) ----------
  addAlert(symbol: string, price: number): AlertView {
    assertSymbol(symbol);
    if (!(price > 0) || !Number.isFinite(price) || price > 10_000_000) throw new DeskError('bad_price', 'alert price out of range');
    const m = this.d.lastMarks[symbol];
    if (!(m > 0)) throw new DeskError('no_mark', 'no current price yet', 409);
    if (this.d.alerts.filter((a) => a.armed).length >= this.caps.maxAlerts) throw new DeskError('too_many_alerts', 'alert limit reached', 429);
    const a: StoredAlert = {
      id: this.rand().slice(0, 12), symbol, kind: price < m ? 'price_below' : 'price_above', level: price, armed: true, createdAt: this.now(),
    };
    this.d.alerts.push(a);
    return { id: a.id, symbol, kind: a.kind, level: price, armed: true, text: this.alertText(a) };
  }

  removeAlert(id: string): boolean {
    const n = this.d.alerts.length;
    this.d.alerts = this.d.alerts.filter((a) => a.id !== id);
    return this.d.alerts.length < n;
  }

  // ---------- money actions: propose -> confirm(token, idempotency key) ----------
  private async currentPosition(symbol: string, marks: Record<string, number>): Promise<VenuePosition> {
    const ps = await this.venue.positions(this.d, marks);
    const p = ps.find((x) => x.symbol === symbol);
    if (!p || !(p.qty > 0)) throw new DeskError('no_position', `no open ${baseOf(symbol)} position`, 409);
    return p;
  }

  private qtyFor(a: ActionSpec, p: VenuePosition): number {
    const step = STEP[a.symbol] ?? 0.001;
    if (a.kind === 'close') return p.qty;
    if (a.kind === 'reduce') {
      const f = a.fraction ?? NaN;
      if (!(f > 0 && f <= 1)) throw new DeskError('bad_fraction', 'reduce fraction must be in (0, 1]');
      const q = f === 1 ? p.qty : floorStep(p.qty * f, step);
      if (!(q > 0)) throw new DeskError('too_small', 'reduce size rounds to zero');
      return Math.min(q, p.qty); // reduce only, never flips
    }
    return 0;
  }

  private checkCaps(a: ActionSpec, qty: number, mark: number, wallet: number) {
    this.rollDay();
    if (this.d.day.actions >= this.caps.maxActionsDay) throw new DeskError('cap_actions', 'daily action limit reached', 429);
    if (a.kind === 'reduce' || a.kind === 'close') {
      if (qty * mark > this.caps.maxOrderNotional) throw new DeskError('cap_notional', `order above ${this.caps.maxOrderNotional} USDT cap`, 403);
    }
    if (a.kind === 'add_margin') {
      const amt = a.amount ?? NaN;
      if (!(amt > 0) || !Number.isFinite(amt)) throw new DeskError('bad_amount', 'margin amount must be positive');
      if (amt > this.caps.maxMarginAdd) throw new DeskError('cap_margin', `max ${this.caps.maxMarginAdd} USDT per action`, 403);
      if (this.d.day.marginAdded + amt > this.caps.maxMarginDay) throw new DeskError('cap_margin_day', 'daily margin limit reached', 403);
      if (amt > wallet) throw new DeskError('insufficient', `only ${Math.floor(wallet)} USDT available`, 409);
    }
  }

  async propose(a: ActionSpec): Promise<Proposal> {
    assertSymbol(a.symbol);
    if (a.kind !== 'reduce' && a.kind !== 'close' && a.kind !== 'add_margin') throw new DeskError('bad_kind', 'not a money action');
    const marks = await this.refreshMarks();
    const p = await this.currentPosition(a.symbol, marks);
    const qty = this.qtyFor(a, p);
    const wallet = await this.venue.available(this.d);
    this.checkCaps(a, qty, p.mark, wallet);
    const now = this.now();
    // drop expired proposals; at most 5 open
    for (const [k, v] of Object.entries(this.d.proposals)) if (v.expiresAt < now || v.used) delete this.d.proposals[k];
    if (Object.keys(this.d.proposals).length >= 5) throw new DeskError('too_many_proposals', 'too many open confirm cards', 429);
    const token = this.rand();
    // store only the fields that matter for this kind (the client cannot smuggle extras into the token)
    const action: ActionSpec =
      a.kind === 'add_margin' ? { kind: a.kind, symbol: a.symbol, amount: a.amount }
        : a.kind === 'reduce' ? { kind: a.kind, symbol: a.symbol, fraction: a.fraction }
          : { kind: 'close', symbol: a.symbol };
    this.d.proposals[token] = { action, expiresAt: now + TOKEN_TTL_MS, used: false };
    const base = baseOf(a.symbol);
    const iso = { symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, margin: p.margin };
    let title = '', lines: string[] = [];
    if (a.kind === 'add_margin') {
      const liqAfter = liqPrice({ ...iso, margin: p.margin + a.amount! });
      title = `Add ${a.amount} USDT margin to ${base} ${p.side}?`;
      lines = [
        `liq ${fmtPrice(p.liq, a.symbol)} -> ${fmtPrice(liqAfter, a.symbol)}`,
        `${fmtPct(liqDistance(p.side, p.mark, p.liq))} -> ${fmtPct(liqDistance(p.side, p.mark, liqAfter))} away · wallet ${Math.floor(wallet)}`,
      ];
    } else {
      const frac = qty / p.qty;
      const pnl = unrealizedPnl({ ...iso, qty }, p.mark);
      title = a.kind === 'close' ? `Close ${base} ${p.side}?` : `Reduce ${base} ${p.side} by ${Math.round(frac * 100)}%?`;
      lines = [
        `${p.side === 'LONG' ? 'sell' : 'buy'} ${fmtQty(qty)} ${base} at ~${fmtPrice(p.mark, a.symbol)} (reduce only)`,
        a.kind === 'close'
          ? `realize ${fmtUsd(pnl)} · frees ${Math.floor(p.margin)} USDT`
          : `realize ${fmtUsd(pnl)} · loss at liq ${fmtUsd(-p.margin)} -> ${fmtUsd(-p.margin * (1 - frac))}`,
      ];
    }
    return { token, expiresAt: now + TOKEN_TTL_MS, action, title, lines };
  }

  cancel(token: string): boolean {
    const p = this.d.proposals[token];
    if (!p) return false;
    delete this.d.proposals[token];
    return true;
  }

  async confirm(token: string, idemKey: string): Promise<ActionResult & { replay?: boolean }> {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(idemKey ?? '')) throw new DeskError('bad_idempotency_key', 'idempotency key required (8-64 chars)');
    const prev = this.d.results[idemKey];
    if (prev) {
      if (prev.token !== token) throw new DeskError('idem_conflict', 'idempotency key reused for another action', 409);
      if (prev.status === 'pending') throw new DeskError('in_progress', 'action in progress', 409);
      if (prev.status === 'failed') throw new DeskError('failed', prev.error ?? 'action failed', 409);
      return { ...prev.result!, replay: true };
    }
    const prop = this.d.proposals[token];
    const now = this.now();
    if (!prop) throw new DeskError('bad_token', 'unknown or used confirm token', 409);
    if (prop.used) throw new DeskError('used_token', 'confirm token already used', 409);
    if (prop.expiresAt < now) { delete this.d.proposals[token]; throw new DeskError('expired', 'confirm card expired, propose again', 409); }
    // consume synchronously, before any await, so a concurrent duplicate cannot run
    prop.used = true;
    this.d.results[idemKey] = { token, status: 'pending' };
    this.d.resultOrder.push(idemKey);
    while (this.d.resultOrder.length > 50) delete this.d.results[this.d.resultOrder.shift()!];
    const a = prop.action;
    try {
      const marks = await this.refreshMarks(); // throws if prices are unavailable: fail closed
      const p = await this.currentPosition(a.symbol, marks);
      const qty = this.qtyFor(a, p);
      const wallet = await this.venue.available(this.d);
      this.checkCaps(a, qty, p.mark, wallet);
      const clientId = 'lg' + idemKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 30);
      const r = await this.venue.execute(this.d, a, qty, marks, clientId);
      this.rollDay();
      this.d.day.actions += 1;
      if (a.kind === 'add_margin') this.d.day.marginAdded += a.amount!;
      const after = (await this.venue.positions(this.d, marks)).find((x) => x.symbol === a.symbol);
      const afterTxt = after && after.qty > 0
        ? `liq ${fmtPrice(after.liq, a.symbol)} · ${fmtPct(liqDistance(after.side, after.mark, after.liq))} away\n` +
          `${fmtQty(after.qty)} ${baseOf(a.symbol)} left · ${Math.round(after.margin)} USDT at risk`
        : `${baseOf(a.symbol)} position closed`;
      const result: ActionResult = { ok: true, action: a, ref: r.ref, summary: r.summary, after: afterTxt, mode: this.venue.mode, at: this.now() };
      this.d.results[idemKey] = { token, status: 'done', result };
      delete this.d.proposals[token];
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.d.results[idemKey] = { token, status: 'failed', error: msg };
      delete this.d.proposals[token];
      if (e instanceof DeskError) throw e;
      throw new DeskError('venue_error', msg, 502);
    }
  }

  // ---------- SIM demo controls (labelled; SIM only) ----------
  setShock(toPct: number, rampMs: number) {
    if (this.venue.mode !== 'SIM') throw new DeskError('sim_only', 'demo controls exist only in SIM mode', 403);
    if (!(Math.abs(toPct) <= 0.2)) throw new DeskError('bad_shock', 'shock must be within +-20%');
    if (!(rampMs >= 0 && rampMs <= 600_000)) throw new DeskError('bad_ramp', 'ramp 0..600 s');
    const now = this.now();
    this.d.sim.shock = { from: shockAt(this.d, now), to: toPct, t0: now, rampMs };
  }

  resetSim() {
    if (this.venue.mode !== 'SIM') throw new DeskError('sim_only', 'demo controls exist only in SIM mode', 403);
    const fresh = emptyDesk();
    this.d.sim = fresh.sim;
    this.d.alerts = [];
    this.d.liqRisk = {};
    this.d.proposals = {};
    this.d.hist = {};
  }
}

export function assertSymbol(s: string) {
  if (!(SYMBOLS as readonly string[]).includes(s)) throw new DeskError('bad_symbol', 'unsupported symbol');
}

export function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- SIM venue: simulated isolated positions marked to live testnet prices ----------
export function simVenue(fetchMarks: (symbols: string[]) => Promise<Record<string, number>>): Venue {
  return {
    mode: 'SIM',
    label: 'SIM',
    marks: fetchMarks,
    async positions(d, marks) {
      return d.sim.positions
        .filter((p) => p.qty > 0 && marks[p.symbol] > 0)
        .map((p) => ({ ...p, liq: liqPrice(p), mark: marks[p.symbol] }));
    },
    async available(d) { return d.sim.wallet; },
    async execute(d, a, qty, marks) {
      const p = d.sim.positions.find((x) => x.symbol === a.symbol);
      if (!p) throw new DeskError('no_position', 'no position', 409);
      const mark = marks[a.symbol];
      d.sim.seq += 1;
      const ref = `SIM-${String(d.sim.seq).padStart(4, '0')}`;
      if (a.kind === 'add_margin') {
        if (a.amount! > d.sim.wallet) throw new DeskError('insufficient', 'not enough wallet balance', 409);
        d.sim.wallet -= a.amount!;
        p.margin += a.amount!;
        return { ref, summary: `ADDED ${a.amount} USDT margin` };
      }
      // reduce / close: isolated margin is released pro rata; realized PnL goes to the wallet
      const frac = Math.min(1, qty / p.qty);
      const realized = unrealizedPnl({ ...p, qty }, mark);
      const released = p.margin * frac;
      p.margin -= released;
      p.qty = Math.max(0, Math.round((p.qty - qty) * 1e8) / 1e8);
      d.sim.wallet += released + realized;
      if (p.qty === 0) d.sim.positions = d.sim.positions.filter((x) => x !== p);
      const verb = p.side === 'LONG' ? 'SOLD' : 'BOUGHT';
      return { ref, summary: `${verb} ${fmtQty(qty)} ${baseOf(a.symbol)} @ ${fmtPrice(mark, a.symbol)}` };
    },
  };
}
