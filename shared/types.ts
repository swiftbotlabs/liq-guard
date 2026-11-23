import type { Side } from './liq';

export type Mode = 'SIM' | 'LIVE';
export type Trend = 'up_fast' | 'up' | 'flat' | 'down' | 'down_fast';

export interface PositionView {
  symbol: string; // BTCUSDT
  base: string; // BTC
  side: Side;
  qty: number;
  entry: number;
  mark: number;
  leverage: number;
  margin: number;
  liq: number;
  liqDist: number; // fraction of mark, positive = safe
  pnl: number; // unrealized, USDT
  pnlPct: number; // pnl / margin
  trend: Trend;
  move1m: number; // fraction, last ~60 s
  risk: 'ok' | 'warn' | 'danger';
}

export interface AlertView {
  id: string;
  symbol: string;
  kind: 'price_above' | 'price_below' | 'liq_warn' | 'liq_danger';
  level?: number;
  armed: boolean;
  firedAt?: number;
  text: string;
}

export type ActionKind = 'reduce' | 'close' | 'add_margin' | 'alert';

export interface ActionSpec {
  kind: ActionKind;
  symbol: string;
  fraction?: number; // reduce
  amount?: number; // add_margin, USDT
  price?: number; // alert
}

export interface Suggestion {
  label: string; // short footer label, e.g. "add 150 margin"
  action?: ActionSpec;
  focus?: string; // symbol to focus instead of an action
}

export interface Proposal {
  token: string;
  expiresAt: number;
  action: ActionSpec;
  title: string; // "ADD 150 USDT MARGIN  BTC LONG?"
  lines: string[]; // two or three effect lines
}

export interface ActionResult {
  ok: boolean;
  action: ActionSpec;
  ref: string; // order id / sim ref
  summary: string; // "REDUCED 0.100 BTC @ 63,050"
  after: string; // "liq 58,210 · 7.6% away"
  mode: Mode;
  at: number;
}

export interface DeskState {
  mode: Mode;
  label: string; // "SIM" or "TESTNET"
  shockPct: number; // SIM demo control (0 when unused)
  positions: PositionView[]; // worst first
  alerts: AlertView[]; // armed + recently fired
  fired: AlertView[]; // fired since the client's last ack
  suggestions: Record<string, Suggestion[]>; // per symbol
  wallet: number; // available USDT (SIM) or availableBalance (LIVE)
  stale: boolean;
  updatedAt: number;
  priceSource?: 'testnet' | 'relay' | 'simulated'; // SIM: "simulated" = every real price route failed; shown on screen
  error?: string;
}
