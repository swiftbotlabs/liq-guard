import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkWav, pcmToWav, MAX_AUDIO_BYTES } from '../worker/src/audio';

describe('audio guards', () => {
  it('accepts the real 16 kHz mono PCM16 test clips', () => {
    for (const f of ['reduce-half.wav', 'alert-60k.wav']) {
      expect(checkWav(new Uint8Array(readFileSync(new URL('../e2e/audio/' + f, import.meta.url))))).toEqual({ ok: true });
    }
  });
  it('wraps raw glasses PCM into a valid WAV', () => {
    expect(checkWav(pcmToWav(new Uint8Array(16_000 * 2)))).toEqual({ ok: true });
  });
  it('rejects wrong content, rate, channels, length', () => {
    expect(checkWav(new TextEncoder().encode('<html>not audio</html>'.padEnd(100)))).toMatchObject({ ok: false });
    const w = pcmToWav(new Uint8Array(16_000 * 2));
    const v = new DataView(w.buffer);
    const r1 = w.slice(); new DataView(r1.buffer).setUint32(24, 44_100, true);
    expect(checkWav(r1)).toEqual({ ok: false, reason: 'must be 16 kHz' });
    const r2 = w.slice(); new DataView(r2.buffer).setUint16(22, 2, true);
    expect(checkWav(r2)).toEqual({ ok: false, reason: 'must be mono' });
    const r3 = w.slice(); new DataView(r3.buffer).setUint32(40, 999, true);
    expect(checkWav(r3)).toEqual({ ok: false, reason: 'length mismatch' });
    expect(checkWav(pcmToWav(new Uint8Array(MAX_AUDIO_BYTES + 2)))).toEqual({ ok: false, reason: 'audio longer than 10 s' });
    expect(checkWav(pcmToWav(new Uint8Array(100)))).toEqual({ ok: false, reason: 'audio shorter than 0.3 s' });
    expect(v.getUint32(24, true)).toBe(16_000);
  });
});
