// Even Hub SDK glue: page specs -> containers, SDK events -> abstract inputs, G2 microphone -> PCM buffer.
import {
  AudioInputSource, CreateStartUpPageContainer, OsEventTypeList, RebuildPageContainer, TextContainerProperty,
  TextContainerUpgrade, type EvenAppBridge, type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type { Page, TextBox } from '../shared/screens';
import type { Input, Mic, Renderer } from './controller';

const MAX_PCM = 16_000 * 2 * 10; // 10 s of 16 kHz PCM16

function prop(b: TextBox, z: number): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: b.x, yPosition: b.y, width: b.w, height: b.h,
    borderWidth: b.border ?? 0, borderColor: b.borderColor ?? 0, borderRadius: b.border ? 4 : 0, paddingLength: b.padding ?? 0,
    containerID: b.id, containerName: b.name, content: b.content, isEventCapture: b.capture ? 1 : 0,
    textColor: b.color ?? 4, zOrderIndex: z,
  });
}

export class GlassesRenderer implements Renderer {
  private current?: Page;
  private started = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private bridge: EvenAppBridge) {}

  show(p: Page): Promise<void> {
    // serialise: the bridge must never see overlapping page calls
    this.queue = this.queue.then(() => this.apply(p)).catch((e) => console.warn('[liqguard] render', e));
    return this.queue;
  }

  private async apply(p: Page) {
    const cur = this.current;
    if (this.started && cur && cur.key === p.key && cur.boxes.length === p.boxes.length) {
      for (const b of p.boxes) {
        const old = cur.boxes.find((x) => x.id === b.id);
        if (old && old.content === b.content && old.color === b.color) continue;
        await this.bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: b.id, containerName: b.name, content: b.content, textColor: b.color ?? 4,
        }));
      }
      this.current = p;
      return;
    }
    const textObject = p.boxes.map((b, i) => prop(b, i + 1)); // capture box first = furthest back
    if (!this.started) {
      const r = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: textObject.length, textObject }));
      if (r !== 0) throw new Error('createStartUpPageContainer failed: ' + r);
      this.started = true;
    } else {
      const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: textObject.length, textObject }));
      if (!ok) throw new Error('rebuildPageContainer failed');
    }
    this.current = p;
  }
}

/** Map SDK events to inputs. Clicks arrive on textEvent or sysEvent (eventType 0 may be normalised to undefined). */
export function toInput(ev: EvenHubEvent): Input | null {
  const t = ev.textEvent ?? ev.listEvent;
  const sys = ev.sysEvent;
  if (sys?.eventType === OsEventTypeList.LONG_PRESS_EVENT) return 'hold_start';
  if (sys?.eventType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return 'hold_end';
  const et = t ? t.eventType : sys ? sys.eventType : null;
  if (t === undefined && sys === undefined) return null;
  switch (et) {
    case OsEventTypeList.CLICK_EVENT:
    case undefined:
      return 'press';
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return 'double';
    case OsEventTypeList.SCROLL_TOP_EVENT:
      return 'up';
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      return 'down';
    default:
      return null; // foreground/exit/IMU events are not inputs
  }
}

export class GlassesMic implements Mic {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private on = false;
  constructor(private bridge: EvenAppBridge) {}

  onAudio(ev: EvenHubEvent) {
    const pcm = ev.audioEvent?.audioPcm;
    if (!this.on || !pcm) return;
    const room = MAX_PCM - this.bytes;
    if (room <= 0) return;
    const c = pcm.byteLength > room ? pcm.subarray(0, room) : pcm;
    this.chunks.push(new Uint8Array(c)); // copy: the host may reuse its buffer
    this.bytes += c.byteLength;
  }

  async start() {
    this.chunks = [];
    this.bytes = 0;
    this.on = true;
    const ok = await this.bridge.audioControl(true, AudioInputSource.Glasses);
    if (!ok) { this.on = false; throw new Error('mic refused'); }
  }

  async stop(): Promise<Uint8Array> {
    this.on = false;
    await this.bridge.audioControl(false);
    const out = new Uint8Array(this.bytes);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.byteLength; }
    this.chunks = []; // audio lives only in memory until it is sent
    return out;
  }
}
