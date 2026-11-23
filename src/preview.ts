// Preview harness. ?fixture=<name> draws one screen from fixed data (no network) for screenshots;
// ?live=1&api=<worker> runs the real controller against a Worker, driven by keys or by window.lg (e2e).
import { Desk, emptyDesk, simVenue } from '../shared/desk';
import { alertPage, confirmPage, glancePage, resultPage, statusPage, voicePage, validatePage, type Page } from '../shared/screens';
import { Api } from './api';
import { Controller, type Input } from './controller';
import { DomRenderer } from './dom';

const q = new URLSearchParams(location.search);
const root = document.getElementById('g2')!;
const r = new DomRenderer(root);
if (q.get('chrome') === '0') document.getElementById('panel')!.remove();

async function fixtures(): Promise<Record<string, Page>> {
  let t = Date.UTC(2026, 10, 23, 16, 0, 0);
  const marks = { BTCUSDT: 63_000, ETHUSDT: 1_780 };
  let factor = 1;
  const desk = new Desk(emptyDesk(), simVenue(async (s) => Object.fromEntries(s.map((k) => [k, marks[k as 'BTCUSDT'] * factor]))), () => t);
  const calm = await desk.state();
  desk.addAlert('BTCUSDT', 60_000);
  factor = 0.997; t += 30_000; await desk.state();
  factor = 0.97; t += 30_000;
  const warn = await desk.state();
  factor = 0.935; t += 30_000;
  const danger = await desk.state();
  const pm = await desk.propose(danger.suggestions.BTCUSDT[0].action!);
  const pr = await desk.propose({ kind: 'reduce', symbol: 'BTCUSDT', fraction: 0.5 });
  const res = await desk.confirm(pr.token, 'fixture-key-1');
  const liqAlert = danger.fired.find((a) => a.kind === 'liq_danger')!;
  const priceAlert = { id: 'p', symbol: 'BTCUSDT', kind: 'price_below' as const, level: 60_000, armed: false, text: 'BTC fell to 60,000' };
  return {
    'glance-calm': glancePage(calm, { pick: 0, blinkOn: true }),
    'glance-warn': glancePage(warn, { pick: 0, blinkOn: true }),
    'glance-danger': glancePage(danger, { pick: 0, blinkOn: true }),
    'glance-danger-dim': glancePage(danger, { pick: 0, blinkOn: false }),
    'glance-eth': glancePage(danger, { pick: 0, blinkOn: true, focus: 'ETHUSDT' }),
    'alert-liq': alertPage(danger, liqAlert, danger.suggestions.BTCUSDT[0]),
    'alert-price': alertPage(danger, priceAlert, danger.suggestions.BTCUSDT[0]),
    'confirm-margin': confirmPage(danger, pm, 27),
    'confirm-reduce': confirmPage(danger, pr, 30),
    'result-reduce': resultPage(res, 'SIM'),
    'result-fail': resultPage({ ok: false, error: 'confirm card expired' }, 'SIM'),
    'voice-listening': voicePage('listening', 'SIM'),
    'voice-thinking': voicePage('thinking', 'SIM'),
    'voice-heard': voicePage('heard', 'SIM', 'what about lunch', "didn't catch an action. try: reduce half, add 200 margin, alert at 60k"),
    'status-stale': statusPage({ ...calm, stale: true, positions: [], error: 'prices unavailable (12 s)' }),
  };
}

async function main() {
  const fx = q.get('fixture');
  if (fx) {
    const all = await fixtures();
    (window as any).fixtureNames = Object.keys(all);
    const p = all[fx] ?? all['glance-calm'];
    const errs = validatePage(p);
    await r.show(p);
    document.body.dataset.ready = errs.length ? 'invalid:' + errs.join(';') : '1';
    return;
  }
  const api = new Api(q.get('api') ?? 'http://127.0.0.1:18787');
  await api.init();
  const ctl = new Controller(api, r, null, { exit: () => { document.body.dataset.exited = '1'; }, now: () => Date.now() });
  (window as any).lg = {
    ctl, api,
    input: (i: Input) => ctl.input(i),
    text: (t: string) => ctl.text(t),
    tick: () => ctl.tick(),
    page: () => ctl.lastPage,
  };
  await ctl.render();
  await ctl.tick();
  if (q.get('poll') !== '0') {
    setInterval(() => void ctl.tick(), 2_000);
    setInterval(() => void ctl.blink(), 1_000);
  }
  const keys: Record<string, Input> = { Enter: 'press', ArrowUp: 'up', ArrowDown: 'down', Backspace: 'double' };
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const i = keys[e.key];
    if (i) { e.preventDefault(); void ctl.input(i); }
  });
  document.getElementById('say')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const el = document.getElementById('sayText') as HTMLInputElement;
    void ctl.text(el.value);
    el.value = '';
  });
  document.body.dataset.ready = '1';
}

main().catch((e) => { document.body.dataset.ready = "error:" + (e as Error).message; });
