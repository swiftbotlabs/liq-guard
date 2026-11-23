// Glasses pages as plain container specs (576 x 288, 4-bit green). The same specs drive the real SDK renderer and
// the HTML preview harness, so a preview screenshot shows exactly the containers the glasses get.
// Rules kept here: <= 8 text containers, exactly one isEventCapture per page, unique ids/names (<= 16 chars),
// textColor 0..4, borderColor 0..15, content <= 1000 chars, glyphs from the firmware's documented set.

import type { ActionResult, AlertView, DeskState, PositionView, Proposal, Suggestion } from './types';
import { fmtPct, fmtPrice, fmtUsd } from './desk';

export interface TextBox {
  id: number;
  name: string;
  x: number; y: number; w: number; h: number;
  content: string;
  color?: number; // text brightness 0..4
  border?: number; // border width 0..5
  borderColor?: number; // 0..15
  padding?: number;
  capture?: boolean;
}

export interface Page {
  key: string; // layout key: same key = same containers, so only text changes (textContainerUpgrade)
  boxes: TextBox[];
}

export const W = 576;
export const H = 288;

const bg = (): TextBox => ({ id: 1, name: 'input', x: 0, y: 0, w: W, h: H, content: ' ', capture: true });

const trendGlyph: Record<PositionView['trend'], string> = {
  down_fast: '▼ fast', down: '▽', flat: '', up: '△', up_fast: '▲ fast',
};

export function sideTrend(p: PositionView): string {
  // "against you" matters: a fast drop on a long is the danger signal
  return trendGlyph[p.trend];
}

function clockOf(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19) + 'Z';
}

/** Header tag. A SIM price shock is a demo control, so it is always shown while active. */
export function modeTag(s: DeskState): string {
  if (s.mode !== 'SIM') return s.label;
  const sh = Math.abs(s.shockPct) >= 0.0005 ? ` shock ${s.shockPct > 0 ? '+' : ''}${(s.shockPct * 100).toFixed(1)}%` : '';
  return `SIM${sh}`;
}

export interface GlanceOpts { focus?: string; pick: number; blinkOn: boolean }

export function glancePage(s: DeskState, o: GlanceOpts): Page {
  if (s.stale || !s.positions.length) return statusPage(s);
  const p = s.positions.find((x) => x.symbol === o.focus) ?? s.positions[0];
  const idx = s.positions.indexOf(p) + 1;
  const sugg = (s.suggestions[p.symbol] ?? [])[o.pick % Math.max(1, (s.suggestions[p.symbol] ?? []).length)];
  const danger = p.risk === 'danger';
  const armed = s.alerts.filter((a) => a.armed && a.symbol === p.symbol);
  const alertLine = armed.length ? `alert ${armed[0].kind === 'price_below' ? 'below' : 'above'} ${fmtPrice(armed[0].level!, p.symbol)} armed` : 'no price alert set';
  return {
    key: `glance:${danger ? 'd' : 'n'}`,
    boxes: [
      bg(),
      { id: 2, name: 'head', x: 8, y: 2, w: 420, h: 32, content: `LIQ GUARD · ${modeTag(s)} · ${idx}/${s.positions.length}`, color: 2 },
      { id: 3, name: 'clock', x: 452, y: 2, w: 124, h: 32, content: clockOf(s.updatedAt), color: 2 },
      { id: 4, name: 'pos', x: 8, y: 38, w: 560, h: 34, content: `${p.base} ${p.side} ${p.leverage}x    ${fmtUsd(p.pnl)}   ROE ${fmtPct(p.pnlPct, 0)}`, color: 4 },
      {
        id: 5, name: 'liq', x: 8, y: 76, w: 560, h: 46, content: `LIQ ${fmtPct(p.liqDist)} AWAY   ${sideTrend(p)}`,
        color: danger ? (o.blinkOn ? 4 : 1) : p.risk === 'warn' ? 4 : 3, border: danger ? 2 : 0, borderColor: 15, padding: danger ? 6 : 0,
      },
      {
        id: 6, name: 'detail', x: 8, y: 128, w: 560, h: 66,
        content: `mark ${fmtPrice(p.mark, p.symbol)}   liq ${fmtPrice(p.liq, p.symbol)}   entry ${fmtPrice(p.entry, p.symbol)}\n${alertLine}`,
        color: 3,
      },
      { id: 7, name: 'pick', x: 8, y: 204, w: 560, h: 34, content: sugg ? `> ${sugg.label}` : '> all calm', color: 4 },
      { id: 8, name: 'hint', x: 8, y: 248, w: 560, h: 34, content: `press: do it   swipe: next   hold: voice`, color: 2 },
    ],
  };
}

export function statusPage(s: DeskState): Page {
  const lines = s.stale
    ? ['NO LIVE PRICES', `${s.error ?? 'testnet unreachable'}`, 'actions locked until prices return']
    : ['NO OPEN POSITION', `${s.label}: nothing to guard`, 'hold: voice  (e.g. "alert at 60k")'];
  return {
    key: 'status',
    boxes: [
      bg(),
      { id: 2, name: 'head', x: 8, y: 2, w: 560, h: 32, content: `LIQ GUARD · ${s.label}`, color: 2 },
      { id: 3, name: 'title', x: 8, y: 70, w: 560, h: 34, content: lines[0], color: 4 },
      { id: 4, name: 'line1', x: 8, y: 110, w: 560, h: 34, content: lines[1], color: 3 },
      { id: 5, name: 'line2', x: 8, y: 248, w: 560, h: 34, content: lines[2], color: 2 },
    ],
  };
}

export function alertPage(s: DeskState, a: AlertView, sugg?: Suggestion): Page {
  const p = s.positions.find((x) => x.symbol === a.symbol);
  return {
    key: 'alert',
    boxes: [
      bg(),
      { id: 2, name: 'head', x: 8, y: 2, w: 560, h: 32, content: `ALERT · ${modeTag(s)}`, color: 2 },
      { id: 3, name: 'title', x: 8, y: 40, w: 560, h: 48, content: `! ${a.text}`, color: 4, border: 2, borderColor: 15, padding: 6 },
      {
        id: 4, name: 'line1', x: 8, y: 98, w: 560, h: 66,
        content: p ? `${p.base} ${p.side} ${p.leverage}x   ${fmtUsd(p.pnl)}\nLIQ ${fmtPct(p.liqDist)} AWAY   ${sideTrend(p)}` : 'no open position on this symbol',
        color: 4,
      },
      { id: 5, name: 'pick', x: 8, y: 204, w: 560, h: 34, content: sugg ? `> ${sugg.label}` : '> dismiss', color: 4 },
      { id: 6, name: 'hint', x: 8, y: 248, w: 560, h: 34, content: 'press: do it   swipe: dismiss   hold: voice', color: 2 },
    ],
  };
}

export function confirmPage(s: Pick<DeskState, 'label' | 'mode'>, pr: Proposal, secondsLeft: number): Page {
  return {
    key: 'confirm',
    boxes: [
      bg(),
      { id: 2, name: 'head', x: 8, y: 2, w: 560, h: 32, content: `CONFIRM · ${s.mode === 'SIM' ? 'SIMULATED' : 'BINANCE TESTNET'}`, color: 2 },
      { id: 3, name: 'title', x: 8, y: 40, w: 560, h: 64, content: pr.title, color: 4, border: 2, borderColor: 15, padding: 6 },
      { id: 4, name: 'lines', x: 8, y: 112, w: 560, h: 96, content: pr.lines.join('\n'), color: 3 },
      { id: 5, name: 'timer', x: 8, y: 212, w: 560, h: 32, content: `valid ${Math.max(0, secondsLeft)} s`, color: 2 },
      { id: 6, name: 'hint', x: 8, y: 248, w: 560, h: 34, content: 'press = YES        swipe = NO', color: 4 },
    ],
  };
}

export function resultPage(r: ActionResult | { ok: false; error: string }, label: string): Page {
  if (!r.ok) {
    return {
      key: 'result',
      boxes: [
        bg(),
        { id: 2, name: 'head', x: 8, y: 2, w: 560, h: 32, content: `NOT DONE · ${label}`, color: 2 },
        { id: 3, name: 'title', x: 8, y: 50, w: 560, h: 34, content: 'NOTHING WAS CHANGED', color: 4 },
        { id: 4, name: 'line1', x: 8, y: 96, w: 560, h: 66, content: (r as { error: string }).error.slice(0, 120), color: 3 },
        { id: 5, name: 'hint', x: 8, y: 248, w: 560, h: 34, content: 'back to glance in 3 s', color: 2 },
      ],
    };
  }
  const ok = r as ActionResult;
  return {
    key: 'result',
    boxes: [
      bg(),
      { id: 2, name: 'head', x: 8, y: 2, w: 560, h: 32, content: `DONE · ${ok.mode === 'SIM' ? 'SIMULATED' : 'BINANCE TESTNET'} · ${ok.ref}`, color: 2 },
      { id: 3, name: 'title', x: 8, y: 50, w: 560, h: 34, content: ok.summary, color: 4 },
      { id: 4, name: 'line1', x: 8, y: 96, w: 560, h: 74, content: ok.after.toUpperCase(), color: 4, border: 2, borderColor: 15, padding: 6 },
      { id: 5, name: 'hint', x: 8, y: 248, w: 560, h: 34, content: 'back to glance in 3 s', color: 2 },
    ],
  };
}

export function voicePage(phase: 'listening' | 'thinking' | 'heard', label: string, text = '', note = ''): Page {
  const title = phase === 'listening' ? 'LISTENING...' : phase === 'thinking' ? 'TRANSCRIBING...' : `"${text.slice(0, 80)}"`;
  const help = phase === 'listening'
    ? 'reduce half · close · add 200 margin · alert at 60k'
    : note;
  return {
    key: 'voice',
    boxes: [
      bg(),
      { id: 2, name: 'head', x: 8, y: 2, w: 560, h: 32, content: `VOICE · ${label} · audio is not stored`, color: 2 },
      { id: 3, name: 'title', x: 8, y: 60, w: 560, h: 66, content: title, color: 4 },
      { id: 4, name: 'line1', x: 8, y: 140, w: 560, h: 66, content: help, color: 3 },
      { id: 5, name: 'hint', x: 8, y: 248, w: 560, h: 34, content: phase === 'listening' ? 'release: send' : 'swipe: back', color: 2 },
    ],
  };
}

export function loadingPage(msg = 'connecting to testnet prices...'): Page {
  return {
    key: 'loading',
    boxes: [
      bg(),
      { id: 2, name: 'head', x: 8, y: 2, w: 560, h: 32, content: 'LIQ GUARD', color: 2 },
      { id: 3, name: 'title', x: 8, y: 110, w: 560, h: 34, content: msg, color: 3 },
    ],
  };
}

/** Static checks mirrored from the SDK docs; used by tests and at runtime before every render. */
export function validatePage(p: Page): string[] {
  const errs: string[] = [];
  if (p.boxes.length > 8) errs.push('more than 8 text containers');
  if (p.boxes.filter((b) => b.capture).length !== 1) errs.push('exactly one capture container required');
  const ids = new Set<number>(), names = new Set<string>();
  for (const b of p.boxes) {
    if (ids.has(b.id)) errs.push(`dup id ${b.id}`);
    if (names.has(b.name)) errs.push(`dup name ${b.name}`);
    ids.add(b.id); names.add(b.name);
    if (b.name.length > 16) errs.push(`name too long ${b.name}`);
    if (b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H) errs.push(`out of canvas ${b.name}`);
    if (b.color !== undefined && !(b.color >= 0 && b.color <= 4)) errs.push(`bad textColor ${b.name}`);
    if (b.border !== undefined && !(b.border >= 0 && b.border <= 5)) errs.push(`bad border ${b.name}`);
    if (b.content.length > 1000) errs.push(`content too long ${b.name}`);
    if (/[−→…]/.test(b.content)) errs.push(`glyph not in documented font set in ${b.name}`);
  }
  return errs;
}
