#!/usr/bin/env python3
"""gen.py: synthesise every phrase in phrases.json with Kokoro (several voices x speeds) as 16 kHz mono PCM16 WAV,
the G2 microphone format the Worker's /api/asr accepts. Clips are regenerable and git-ignored; manifest.json is committed.
usage: gen.py [--voices af_heart,af_bella,am_michael,bf_emma,bm_george] [--speeds 0.85,1.0,1.15]"""
import argparse, hashlib, json, os, struct, subprocess, sys
import numpy as np
from kokoro_onnx import Kokoro  # pip install kokoro-onnx; weights kokoro-v1.0.onnx + voices-v1.0.bin in $KOKORO_DIR
HERE = os.path.dirname(os.path.realpath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument('--voices', default='af_heart,af_bella,am_michael,bf_emma,bm_george')
ap.add_argument('--speeds', default='0.85,1.0,1.15')
a = ap.parse_args()
P = json.load(open(f'{HERE}/phrases.json'))
items = [(c['cmd'], s, c['expect']) for c in P['commands'] for s in c['say']] + [('negative', s, {'type': 'unknown'}) for s in P['negatives']]
KD = os.environ.get('KOKORO_DIR', 'kokoro')
k = Kokoro(f'{KD}/kokoro-v1.0.onnx', f'{KD}/voices-v1.0.bin')


def check_wav(b):  # mirror of worker/src/audio.ts checkWav
    if len(b) < 44 or b[0:4] != b'RIFF' or b[8:12] != b'WAVE' or b[12:16] != b'fmt ' or b[36:40] != b'data':
        return 'not a canonical PCM WAV'
    fmt, ch, sr = struct.unpack('<HHI', b[20:28]); bits = struct.unpack('<H', b[34:36])[0]; n = struct.unpack('<I', b[40:44])[0]
    if (fmt, ch, sr, bits) != (1, 1, 16000, 16) or n != len(b) - 44: return 'format'
    if n > 16000 * 2 * 10: return 'longer than 10 s'
    if n < 16000 * 2 * 0.3: return 'shorter than 0.3 s'
    return None


man = []
for v in a.voices.split(','):
    for sp in [float(x) for x in a.speeds.split(',')]:
        d = f'{HERE}/clips/{v}_{sp:.2f}'
        os.makedirs(d, exist_ok=True)
        for i, (cmd, text, exp) in enumerate(items):
            f = f'{d}/{i:03d}.wav'
            if not os.path.exists(f):
                lang = 'en-gb' if v.startswith(('bf_', 'bm_')) else 'en-us'
                s, sr = k.create(text, voice=v, speed=sp, lang=lang)
                pcm = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(sr), '-ac', '1', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'],
                                     input=np.asarray(s, np.float32).tobytes(), capture_output=True, check=True).stdout
                hdr = b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, 16000, 32000, 2, 16) + b'data' + struct.pack('<I', len(pcm))
                open(f + '.part', 'wb').write(hdr + pcm); os.replace(f + '.part', f)
            b = open(f, 'rb').read()
            err = check_wav(b)
            if err: sys.exit(f'clip fails the Worker audio guard: {f}: {err}')
            man.append({'clip': os.path.relpath(f, HERE), 'voice': v, 'speed': sp, 'cmd': cmd, 'text': text, 'expect': exp,
                        'seconds': round((len(b) - 44) / 32000, 2), 'sha256': hashlib.sha256(b).hexdigest()[:16]})
        print(f'{v} {sp}: {len(items)} clips', flush=True)
json.dump({'voices': a.voices.split(','), 'speeds': a.speeds, 'clips': man}, open(f'{HERE}/manifest.json', 'w'), indent=1)
print('manifest', len(man), 'clips')
