// Audio guards for /api/asr: 16 kHz, mono, signed 16-bit PCM (the G2 microphone format), at most 10 s.
export const SAMPLE_RATE = 16_000;
export const MAX_SECONDS = 10;
export const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * MAX_SECONDS; // PCM payload, header excluded
export const MIN_AUDIO_BYTES = SAMPLE_RATE * 2 * 0.3; // 0.3 s

export function pcmToWav(pcm: Uint8Array): Uint8Array {
  const n = pcm.byteLength - (pcm.byteLength % 2);
  const out = new Uint8Array(44 + n);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n, true);
  out.set(pcm.subarray(0, n), 44);
  return out;
}

/** Content check by bytes, not by the declared type. Accepts only the canonical 44-byte PCM header we produce. */
export function checkWav(b: Uint8Array): { ok: true } | { ok: false; reason: string } {
  if (b.byteLength < 44) return { ok: false, reason: 'audio too short' };
  const s = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (s(0) !== 'RIFF' || s(8) !== 'WAVE' || s(12) !== 'fmt ' || s(36) !== 'data') return { ok: false, reason: 'not a PCM WAV' };
  if (v.getUint16(20, true) !== 1) return { ok: false, reason: 'not PCM' };
  if (v.getUint16(22, true) !== 1) return { ok: false, reason: 'must be mono' };
  if (v.getUint32(24, true) !== SAMPLE_RATE) return { ok: false, reason: 'must be 16 kHz' };
  if (v.getUint16(34, true) !== 16) return { ok: false, reason: 'must be 16-bit' };
  const n = v.getUint32(40, true);
  if (n !== b.byteLength - 44) return { ok: false, reason: 'length mismatch' };
  if (n > MAX_AUDIO_BYTES) return { ok: false, reason: 'audio longer than 10 s' };
  if (n < MIN_AUDIO_BYTES) return { ok: false, reason: 'audio shorter than 0.3 s' };
  return { ok: true };
}
