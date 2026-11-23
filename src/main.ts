// Entry inside the Even Realities App WebView: glasses UI via the SDK; the phone screen shows status, privacy and a typed
// fallback. Outside the app (plain browser) it points to the preview harness instead.
import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { Api, type KV } from './api';
import { API_BASE, POLL_MS } from './config';
import { Controller } from './controller';
import { GlassesMic, GlassesRenderer, toInput } from './glasses';

const $ = (id: string) => document.getElementById(id)!;

function bridgeKV(b: EvenAppBridge): KV {
  return {
    async get(k) { try { return (await b.getLocalStorage(k)) || null; } catch { return null; } },
    async set(k, v) { try { await b.setLocalStorage(k, v); } catch { /* ignore */ } },
  };
}

async function findBridge(ms: number): Promise<EvenAppBridge | null> {
  return Promise.race([waitForEvenAppBridge(), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

async function boot() {
  const bridge = await findBridge(3_000);
  if (!bridge) {
    $('status').textContent = 'Not running inside the Even Realities App. Open preview.html to try the glasses screens in a browser.';
    return;
  }
  const api = new Api(API_BASE, bridgeKV(bridge));
  const mic = new GlassesMic(bridge);
  const ctl = new Controller(api, new GlassesRenderer(bridge), mic, {
    exit: () => void bridge.shutDownPageContainer(1), // root page: the system asks the user to confirm exit
    now: () => Date.now(),
  });
  bridge.onEvenHubEvent((ev) => {
    if (ev.audioEvent) { mic.onAudio(ev); return; }
    const i = toInput(ev);
    if (i) void ctl.input(i);
  });
  await ctl.render(); // startup page first (the G2 mic needs it)
  try {
    await api.init();
  } catch (e) {
    $('status').textContent = 'Server unreachable: ' + (e as Error).message;
  }
  const loop = async () => { await ctl.tick(); updatePhone(ctl); setTimeout(loop, POLL_MS); };
  void loop();
  setInterval(() => void ctl.blink(), 1_000);
  ($('cmd') as HTMLFormElement).addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('cmdText') as HTMLInputElement;
    const t = inp.value.trim().slice(0, 200);
    inp.value = '';
    if (t) void ctl.text(t);
  });
}

function updatePhone(ctl: Controller) {
  const d = ctl.desk;
  $('mode').textContent = d ? (d.mode === 'SIM' ? 'SIM: simulated position, live Binance futures testnet prices' : 'Binance futures TESTNET account') : '...';
  const p = d?.positions[0];
  $('status').textContent = d?.stale ? 'Prices unavailable: actions are locked.' : p
    ? `${p.base} ${p.side} ${p.leverage}x · liquidation ${(p.liqDist * 100).toFixed(1)}% away · screen: ${ctl.screen}`
    : 'No open position.';
}

void boot();
