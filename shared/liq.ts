// Liquidation math for Binance USDT-M futures, ISOLATED margin, one-way mode, one position per symbol.
//
// Binance's published formula (USDT-M, isolated, single position):
//   LP = (WB + cum - side * Q * EP) / (Q * MMR - side * Q)
//   WB  = isolated wallet balance of the position (its margin)
//   cum = maintenance amount of the position's bracket
//   side = +1 long, -1 short; Q = absolute size; EP = entry price; MMR = maintenance margin rate of the bracket
// In LIVE mode the venue reports liquidationPrice itself; this module is used for SIM and for "what if" previews.

export interface Bracket {
  floor: number; // notional floor (USDT)
  cap: number; // notional cap (USDT)
  maxLev: number;
  mmr: number; // maintenance margin rate
  cum: number; // maintenance amount
}

type RawTier = [floor: number, cap: number, maxLev: number, mmr: number];

// Snapshot of Binance's published USDT-M bracket tables (BTCUSDT, ETHUSDT). LIVE mode reads
// /fapi/v1/leverageBracket instead. `cum` is derived so the table is self-consistent:
//   cum_n = cum_{n-1} + floor_n * (mmr_n - mmr_{n-1})
const RAW: Record<string, RawTier[]> = {
  BTCUSDT: [
    [0, 50_000, 125, 0.004],
    [50_000, 600_000, 100, 0.005],
    [600_000, 3_000_000, 75, 0.0065],
    [3_000_000, 12_000_000, 50, 0.01],
    [12_000_000, 70_000_000, 25, 0.02],
    [70_000_000, 100_000_000, 20, 0.025],
    [100_000_000, 230_000_000, 10, 0.05],
    [230_000_000, 480_000_000, 5, 0.1],
    [480_000_000, 600_000_000, 4, 0.125],
    [600_000_000, 800_000_000, 3, 0.15],
    [800_000_000, 1_200_000_000, 2, 0.25],
    [1_200_000_000, 1_800_000_000, 1, 0.5],
  ],
  ETHUSDT: [
    [0, 50_000, 125, 0.004],
    [50_000, 600_000, 100, 0.005],
    [600_000, 3_000_000, 75, 0.0065],
    [3_000_000, 12_000_000, 50, 0.01],
    [12_000_000, 50_000_000, 25, 0.02],
    [50_000_000, 65_000_000, 20, 0.025],
    [65_000_000, 150_000_000, 10, 0.05],
    [150_000_000, 320_000_000, 5, 0.1],
    [320_000_000, 400_000_000, 4, 0.125],
    [400_000_000, 530_000_000, 3, 0.15],
    [530_000_000, 800_000_000, 2, 0.25],
    [800_000_000, 1_200_000_000, 1, 0.5],
  ],
};

function build(raw: RawTier[]): Bracket[] {
  const out: Bracket[] = [];
  let cum = 0;
  let prevMmr = 0;
  for (const [floor, cap, maxLev, mmr] of raw) {
    cum = cum + floor * (mmr - prevMmr);
    out.push({ floor, cap, maxLev, mmr, cum: Math.round(cum * 1e6) / 1e6 });
    prevMmr = mmr;
  }
  return out;
}

export const BRACKETS: Record<string, Bracket[]> = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k, build(v)]),
);

export function bracketFor(symbol: string, notional: number, table = BRACKETS): Bracket {
  const tiers = table[symbol];
  if (!tiers) throw new Error(`no bracket table for ${symbol}`);
  const n = Math.abs(notional);
  for (const t of tiers) if (n >= t.floor && n < t.cap) return t;
  return tiers[tiers.length - 1];
}

export type Side = 'LONG' | 'SHORT';
export const sideSign = (s: Side): 1 | -1 => (s === 'LONG' ? 1 : -1);

export interface IsoPosition {
  symbol: string;
  side: Side;
  qty: number; // absolute size in base asset
  entry: number;
  margin: number; // isolated margin (wallet balance of the position), USDT
}

/** Isolated liquidation price. Bracket chosen by notional at entry (Binance uses position notional). */
export function liqPrice(p: IsoPosition, table = BRACKETS): number {
  if (!(p.qty > 0) || !(p.entry > 0) || !(p.margin >= 0)) return NaN;
  const s = sideSign(p.side);
  const b = bracketFor(p.symbol, p.qty * p.entry, table);
  const lp = (p.margin + b.cum - s * p.qty * p.entry) / (p.qty * b.mmr - s * p.qty);
  return lp > 0 ? lp : 0;
}

/** Distance from mark to liquidation as a fraction of mark, positive while safe. */
export function liqDistance(side: Side, mark: number, liq: number): number {
  if (!(mark > 0) || !(liq >= 0)) return NaN;
  return side === 'LONG' ? (mark - liq) / mark : (liq - mark) / mark;
}

export function unrealizedPnl(p: Pick<IsoPosition, 'side' | 'qty' | 'entry'>, mark: number): number {
  return sideSign(p.side) * p.qty * (mark - p.entry);
}

/** Margin to add so that the liq distance reaches `target` (fraction) at the current mark. Solves the formula for WB. */
export function marginForDistance(p: IsoPosition, mark: number, target: number, table = BRACKETS): number {
  const s = sideSign(p.side);
  const b = bracketFor(p.symbol, p.qty * p.entry, table);
  const wantLiq = s === 1 ? mark * (1 - target) : mark * (1 + target);
  // LP*(Q*MMR - s*Q) = WB + cum - s*Q*EP  =>  WB = LP*(Q*MMR - s*Q) - cum + s*Q*EP
  const wb = wantLiq * (p.qty * b.mmr - s * p.qty) - b.cum + s * p.qty * p.entry;
  return Math.max(0, wb - p.margin);
}

/** Effective leverage = notional at entry / margin. */
export function leverage(p: IsoPosition): number {
  return p.margin > 0 ? (p.qty * p.entry) / p.margin : Infinity;
}
