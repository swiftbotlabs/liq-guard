import { describe, expect, it } from 'vitest';
import { Desk, emptyDesk, simVenue } from '../shared/desk';
import { alertPage, confirmPage, glancePage, loadingPage, resultPage, statusPage, validatePage, voicePage } from '../shared/screens';

describe('every page obeys the container rules', async () => {
  const desk = new Desk(emptyDesk(), simVenue(async () => ({ BTCUSDT: 63_000, ETHUSDT: 3_000 })));
  const s = await desk.state();
  const pr = await desk.propose({ kind: 'reduce', symbol: 'BTCUSDT', fraction: 0.5 });
  const pages = {
    glance: glancePage(s, { pick: 0, blinkOn: true }),
    glanceEth: glancePage(s, { pick: 3, blinkOn: false, focus: 'ETHUSDT' }),
    status: statusPage({ ...s, stale: true, positions: [] }),
    alert: alertPage(s, { id: 'x', symbol: 'BTCUSDT', kind: 'liq_danger', armed: false, text: 'BTC liquidation under 5% away' }),
    confirm: confirmPage(s, pr, 30),
    result: resultPage({ ok: true, action: pr.action, ref: 'SIM-0001', summary: 'SOLD 0.1 BTC @ 63,000', after: 'liq 58,000 · 7.9% away', mode: 'SIM', at: 0 }, 'SIM'),
    fail: resultPage({ ok: false, error: 'confirm card expired' }, 'SIM'),
    voice: voicePage('listening', 'SIM'),
    loading: loadingPage(),
  };
  for (const [k, p] of Object.entries(pages)) it(k, () => expect(validatePage(p)).toEqual([]));
  it('positive control: validator catches two capture containers', () => {
    const bad = { ...pages.glance, boxes: pages.glance.boxes.map((b) => ({ ...b, capture: true })) };
    expect(validatePage(bad)).toContain('exactly one capture container required');
  });
  it('an active SIM shock is labelled', () => {
    const g = glancePage({ ...s, shockPct: -0.07 }, { pick: 0, blinkOn: true });
    expect(g.boxes.find((b) => b.name === 'head')!.content).toContain('SIM shock -7.0%');
  });
  it('SIM is labelled on the glance', () => {
    expect(pages.glance.boxes.find((b) => b.name === 'head')!.content).toContain('SIM');
    expect(pages.confirm.boxes.find((b) => b.name === 'head')!.content).toContain('SIMULATED');
  });
});
