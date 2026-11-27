#!/bin/bash
# One command: clips (Kokoro) -> whisper.cpp -> the app's parseIntent -> pass rates -> VOICE-REGRESSION.md.
# usage: test/voice-regression/run.sh   (~70 min on 6 CPU cores)
# needs: python3 with kokoro-onnx numpy (KOKORO_DIR = folder with kokoro-v1.0.onnx + voices-v1.0.bin), ffmpeg,
#        whisper.cpp (WHISPER_CLI, WHISPER_MODEL_BASE, WHISPER_MODEL_TURBO)
set -euo pipefail
cd "$(dirname "$0")"
E=../../node_modules/.bin/esbuild
mkdir -p build
$E ../../shared/intents.ts --format=esm --outfile=build/intents.mjs --log-level=warning
git show d510242:shared/intents.ts > build/intents-baseline.ts
$E build/intents-baseline.ts --format=esm --outfile=build/intents-baseline.mjs --log-level=warning
node score_text.mjs
${PYTHON:-python3} gen.py
./asr.py base
./asr.py turbo af_heart_1.00 am_michael_1.00 bf_emma_1.00
node score.mjs base current && node score.mjs base baseline && node score.mjs turbo current && node score.mjs turbo baseline
python3 report.py
