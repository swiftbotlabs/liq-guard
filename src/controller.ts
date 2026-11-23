// UI state machine for the glasses. Inputs are abstract (press, swipe, hold) so the same code runs on G2 (SDK events),
// in the HTML preview (keyboard) and in tests. Every money action goes glance/voice -> confirm card -> one press.
import type { Api, TextReply } from './api';
import { ApiError, idemKey } from './api';
import type { ActionResult, AlertView, DeskState, Proposal, Suggestion } from '../shared/types';
import {
  alertPage, confirmPage, glancePage, loadingPage, resultPage, statusPage, validatePage, voicePage, type Page,
} from '../shared/screens';

export type Input = 'press' | 'double' | 'up' | 'down' | 'hold_start' | 'hold_end';
export type Screen = 'loading' | 'glance' | 'alert' | 'confirm' | 'result' | 'voice';

export interface Renderer { show(p: Page): Promise<void> }
export interface Mic { start(): Promise<void>; stop(): Promise<Uint8Array> }
export interface Host { exit(): void; now(): number }

export class Controller {
  screen: Screen = 'loading';
  desk: DeskState | null = null;
  focus?: string;
  pick = 0;
  proposal?: Proposal;
  alert?: AlertView;
  result?: ActionResult | { ok: false; error: string };
  voice: { phase: 'listening' | 'thinking' | 'heard'; text: string; note: string } = { phase: 'listening', text: '', note: '' };
  private seen = new Set<string>();
  private blinkOn = true;
  private busy = false;
  private backTimer?: ReturnType<typeof setTimeout>;
  private primed = false;
  lastPage?: Page;

  constructor(private api: Api, private r: Renderer, private mic: Mic | null, private host: Host) {}

  get label() { return this.desk?.label ?? '...'; }

  private currentSymbol(): string | undefined {
    const ps = this.desk?.positions ?? [];
    return (ps.find((p) => p.symbol === this.focus) ?? ps[0])?.symbol;
  }

  private suggestions(symbol?: string): Suggestion[] {
    const s = symbol ?? this.currentSymbol();
    return s ? this.desk?.suggestions[s] ?? [] : [];
  }

  async render(): Promise<void> {
    let page: Page;
    const d = this.desk;
    switch (this.screen) {
      case 'loading': page = loadingPage(); break;
      case 'glance': page = d ? glancePage(d, { focus: this.focus, pick: this.pick, blinkOn: this.blinkOn }) : loadingPage(); break;
      case 'alert': page = d && this.alert ? alertPage(d, this.alert, this.suggestions(this.alert.symbol)[0]) : statusPage(d!); break;
      case 'confirm': page = confirmPage(d ?? { label: 'SIM', mode: 'SIM' }, this.proposal!, Math.ceil((this.proposal!.expiresAt - this.host.now()) / 1000)); break;
      case 'result': page = resultPage(this.result!, this.label); break;
      case 'voice': page = voicePage(this.voice.phase, this.label, this.voice.text, this.voice.note); break;
    }
    const errs = validatePage(page);
    if (errs.length) throw new Error('page invalid: ' + errs.join('; '));
    this.lastPage = page;
    await this.r.show(page);
  }

  /** Poll tick (every ~2 s): new state, alert pop-ups, countdown. */
  async tick(): Promise<void> {
    try {
      this.desk = await this.api.state();
    } catch (e) {
      if (this.desk) this.desk = { ...this.desk, stale: true, positions: [], error: (e as Error).message };
    }
    const d = this.desk;
    if (d && !this.primed) {
      // alerts that fired before this session opened are not news
      for (const a of d.fired) this.seen.add(a.id);
      this.primed = true;
    }
    if (d) {
      const fresh = d.fired.filter((a) => !this.seen.has(a.id));
      for (const a of fresh) this.seen.add(a.id);
      if (fresh.length && (this.screen === 'glance' || this.screen === 'loading')) {
        // the most serious new alert wins
        const order = { liq_danger: 0, price_below: 1, price_above: 1, liq_warn: 2 } as const;
        this.alert = fresh.sort((a, b) => order[a.kind] - order[b.kind])[0];
        this.screen = 'alert';
      }
    }
    if (this.screen === 'loading' && d) this.screen = 'glance';
    if (this.screen === 'confirm' && this.proposal && this.host.now() > this.proposal.expiresAt) {
      await this.cancelProposal('confirm card expired');
      return;
    }
    if (this.screen === 'glance' || this.screen === 'alert' || this.screen === 'confirm') await this.render();
  }

  /** 1 Hz: blink the danger line, count down the confirm card. */
  async blink(): Promise<void> {
    this.blinkOn = !this.blinkOn;
    const danger = this.desk?.positions.some((p) => p.risk === 'danger');
    if ((this.screen === 'glance' && danger) || this.screen === 'confirm') await this.render();
  }

  private goGlance(delayMs = 0) {
    if (this.backTimer) clearTimeout(this.backTimer);
    const go = async () => {
      this.backTimer = undefined;
      // a delayed return only leaves transient screens; it never yanks the user off a confirm card or alert
      if (delayMs && this.screen !== 'result' && this.screen !== 'voice') return;
      this.screen = 'glance';
      await this.render();
    };
    if (delayMs) this.backTimer = setTimeout(() => void go(), delayMs);
    else void go();
  }

  private async fail(msg: string) {
    this.result = { ok: false, error: msg };
    this.screen = 'result';
    await this.render();
    this.goGlance(3_000);
  }

  private async run(s: Suggestion) {
    if (s.focus) { this.focus = s.focus; this.pick = 0; this.screen = 'glance'; await this.render(); return; }
    const a = s.action;
    if (!a) return;
    if (a.kind === 'alert') {
      try {
        const al = await this.api.addAlert(a.symbol, a.price!);
        this.result = { ok: true, action: a, ref: 'alert', summary: 'ALERT SET', after: al.text, mode: this.desk?.mode ?? 'SIM', at: this.host.now() };
        this.screen = 'result';
        await this.render();
        this.goGlance(2_500);
      } catch (e) { await this.fail((e as Error).message); }
      return;
    }
    try {
      this.proposal = await this.api.propose(a);
      this.screen = 'confirm';
      await this.render();
    } catch (e) { await this.fail((e as Error).message); }
  }

  private async cancelProposal(why?: string) {
    const p = this.proposal;
    this.proposal = undefined;
    if (p) this.api.cancel(p.token).catch(() => undefined);
    if (why) await this.fail(why);
    else this.goGlance();
  }

  private async confirmProposal() {
    const p = this.proposal;
    if (!p) return;
    const key = idemKey();
    let r: ActionResult | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      try { r = await this.api.confirm(p.token, key); } catch (e) {
        lastErr = e;
        // only a network failure is retried, with the SAME idempotency key, so it cannot execute twice
        if (!(e instanceof ApiError && e.code === 'network')) break;
      }
    }
    this.proposal = undefined;
    if (!r) { await this.fail((lastErr as Error)?.message ?? 'failed'); return; }
    this.result = r;
    this.screen = 'result';
    await this.render();
    this.goGlance(3_000);
    void this.tick();
  }

  private async handleReply(rep: TextReply) {
    if (rep.proposal) { this.proposal = rep.proposal; this.screen = 'confirm'; await this.render(); return; }
    if (rep.alert) {
      this.result = { ok: true, action: { kind: 'alert', symbol: rep.alert.symbol, price: rep.alert.level }, ref: 'alert', summary: 'ALERT SET', after: rep.alert.text, mode: this.desk?.mode ?? 'SIM', at: this.host.now() };
      this.screen = 'result';
      await this.render();
      this.goGlance(2_500);
      return;
    }
    if (rep.intent.type === 'focus') { this.focus = rep.intent.symbol; this.pick = 0; this.goGlance(); return; }
    if (rep.intent.type === 'cancel') { this.goGlance(); return; }
    this.voice = { phase: 'heard', text: rep.text || '(silence)', note: "didn't catch an action. try: reduce half, add 200 margin, alert at 60k" };
    this.screen = 'voice';
    await this.render();
    this.goGlance(3_500);
  }

  /** Typed command (phone screen or tests): same path as voice after transcription. */
  async text(t: string) {
    if (this.busy) return;
    this.busy = true;
    try { await this.handleReply(await this.api.intent(t, this.currentSymbol())); } catch (e) { await this.fail((e as Error).message); } finally { this.busy = false; }
  }

  async input(ev: Input): Promise<void> {
    if (this.busy && ev !== 'hold_end') return;
    if (ev === 'hold_start') {
      if (!this.mic || this.screen === 'confirm') return; // never start voice on top of a confirm card
      if (this.backTimer) clearTimeout(this.backTimer);
      this.voice = { phase: 'listening', text: '', note: '' };
      this.screen = 'voice';
      await this.render();
      try { await this.mic.start(); } catch { await this.fail('microphone unavailable'); }
      return;
    }
    if (ev === 'hold_end') {
      if (this.screen !== 'voice' || this.voice.phase !== 'listening' || !this.mic) return;
      this.busy = true;
      try {
        const pcm = await this.mic.stop();
        this.voice = { phase: 'thinking', text: '', note: '' };
        await this.render();
        await this.handleReply(await this.api.asr(pcm, this.currentSymbol()));
      } catch (e) { await this.fail((e as Error).message); } finally { this.busy = false; }
      return;
    }
    this.busy = true;
    try {
      switch (this.screen) {
        case 'glance': {
          const sug = this.suggestions();
          if (ev === 'press' && sug.length) await this.run(sug[this.pick % sug.length]);
          else if (ev === 'down') { this.pick = (this.pick + 1) % Math.max(1, sug.length); await this.render(); }
          else if (ev === 'up') { this.pick = (this.pick - 1 + Math.max(1, sug.length)) % Math.max(1, sug.length); await this.render(); }
          else if (ev === 'double') this.host.exit(); // root page: system exit dialog
          break;
        }
        case 'alert': {
          const sym = this.alert?.symbol;
          this.alert = undefined;
          if (ev === 'press') {
            const s = this.suggestions(sym)[0];
            this.focus = sym;
            this.pick = 0;
            if (s) await this.run(s); else this.goGlance();
          } else this.goGlance();
          break;
        }
        case 'confirm':
          if (ev === 'press') await this.confirmProposal();
          else await this.cancelProposal(); // swipe or double = NO
          break;
        case 'result':
        case 'voice':
          this.goGlance();
          break;
        default:
          break;
      }
    } finally {
      this.busy = false;
    }
  }
}
