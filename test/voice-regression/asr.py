#!/usr/bin/env python3
"""asr.py <model: base|turbo> [condition dirs...]: transcribe every clip in manifest.json with whisper.cpp (one process per
condition, model loaded once) -> transcripts-<model>.json {clip: text}. Cached per clip sha256."""
import json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.realpath(__file__))
# whisper.cpp binary and ggml models (https://github.com/ggml-org/whisper.cpp): set these env vars
WHISPER = os.environ.get('WHISPER_CLI', 'whisper-cli')
MODELS = {'base': os.environ.get('WHISPER_MODEL_BASE', 'models/ggml-base-q8_0.bin'),
          'turbo': os.environ.get('WHISPER_MODEL_TURBO', 'models/ggml-large-v3-turbo-q5_0.bin')}
model = sys.argv[1]
only = set(sys.argv[2:])
man = json.load(open(f'{HERE}/manifest.json'))['clips']
outp = f'{HERE}/transcripts-{model}.json'
tr = json.load(open(outp)) if os.path.exists(outp) else {}
key = lambda c: f"{c['clip']}|{c['sha256']}"
groups = {}
for c in man:
    cond = os.path.dirname(c['clip'])
    if (only and os.path.basename(cond) not in only) or key(c) in tr:
        continue
    groups.setdefault(cond, []).append(c)
for cond, cs in groups.items():
    with tempfile.TemporaryDirectory(dir=HERE) as td:
        args = [WHISPER, '-m', MODELS[model], '-l', 'en', '-t', '4', '-np', '-nt', '-oj']
        for i, c in enumerate(cs):
            dst = f'{td}/{i:03d}.wav'
            os.symlink(f"{HERE}/{c['clip']}", dst)
            args += ['-f', dst]
        r = subprocess.run(args, capture_output=True, text=True, timeout=7200)
        if r.returncode != 0:
            sys.exit(f'whisper rc {r.returncode} on {cond}: {r.stderr[-300:]}')
        for i, c in enumerate(cs):
            j = json.load(open(f'{td}/{i:03d}.wav.json'))
            tr[key(c)] = ' '.join(s['text'].strip() for s in j.get('transcription', [])).strip()
    json.dump(tr, open(outp, 'w'), indent=1)
    print(f'{model} {cond}: {len(cs)} transcribed', flush=True)
print(f'{model}: {len(tr)} transcripts total')
