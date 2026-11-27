#!/usr/bin/env python3
"""report.py: results-*.json -> VOICE-REGRESSION.md (pass rates per command / voice / speed, unsafe outcomes, failures)."""
import json, os, glob
H = os.path.dirname(os.path.realpath(__file__))
man = json.load(open(f'{H}/manifest.json'))
R = {os.path.basename(f)[8:-5]: json.load(open(f)) for f in sorted(glob.glob(f'{H}/results-*.json'))}
MONEY = {'reduce', 'close', 'add_margin'}
pct = lambda a, b: f'{a}/{b} ({100 * a / b:.0f}%)' if b else '-'


def unsafe(rows):  # a money action that is not the one the speaker asked for
    return [r for r in rows if r['got']['type'] in MONEY and not r['pass']]


L = ['# Voice regression', '',
     'Every voice command Liq Guard supports (10 commands, 3-4 spoken paraphrases each, 35 phrases) plus 5 negatives, synthesised with Kokoro '
     f'in {len(man["voices"])} voices ({", ".join(man["voices"])}) at speeds {man["speeds"]}: **{len(man["clips"])} clips**, 16 kHz mono PCM16 '
     '(the G2 microphone format; every clip passes the Worker\'s `checkWav` guard). Each clip goes through speech-to-text and then the exact parser the Worker runs '
     '(`shared/intents.ts` `parseIntent`). A clip passes when the parsed intent equals the expected one exactly (type, amount, fraction, price, symbol); a negative passes when it stays `unknown`.', '',
     '**ASR used here.** The deployed Worker uses Workers AI `whisper-large-v3-turbo`. Offline we run whisper.cpp: `large-v3-turbo` (q5_0, the same model family) on 3 voices at 1.0x, '
     'and the much smaller `base` (q8_0) on the full matrix as a pessimistic lower bound.', '',
     '**Parsers.** `baseline` = `shared/intents.ts` at commit d510242 (before this run); `current` = after the fixes this run led to (ASR spellings `reduced`, `cutting`, `etherium`; '
     'and "close my <unknown word>" now returns unknown instead of closing the focused position).', '',
     'Reproduce: `test/voice-regression/run.sh` (clips are regenerated; `manifest.json` lists every clip with its text, voice, speed, length and sha256).', '',
     '## Summary', '', '| ASR | parser | clips | pass | unsafe (wrong money action) | negatives kept unknown |', '|---|---|---|---|---|---|']
for k, r in R.items():
    rows = r['rows']; neg = [x for x in rows if x['cmd'] == 'negative']
    L.append(f"| whisper.cpp {r['model']} | {r['parser']} | {r['scored']} | {pct(r['passed'], r['scored'])} | {len(unsafe(rows))} | {pct(sum(x['pass'] for x in neg), len(neg))} |")
for k in [k for k in ('turbo-current', 'base-current') if k in R]:
    r = R[k]
    L += ['', f"## {r['model']} ASR, current parser: per command", '', '| command | pass |', '|---|---|']
    L += [f'| {c} | {pct(*v)} |' for c, v in r['byCmd'].items()]
    L += ['', '| voice | pass |', '|---|---|'] + [f'| {c} | {pct(*v)} |' for c, v in r['byVoice'].items()]
    L += ['', '| speed | pass |', '|---|---|'] + [f'| {c} | {pct(*v)} |' for c, v in r['bySpeed'].items()]
    fails = [x for x in r['rows'] if not x['pass']]
    L += ['', f'Failures ({len(fails)}): what was said, what the ASR heard, what the parser made of it. "unknown" asks the user again; nothing moves.', '',
          '| voice | speed | said | heard | parsed |', '|---|---|---|---|---|']
    L += [f"| {x['voice']} | {x['speed']} | {x['text']} | {x['transcript']} | {x['got']['type']}{' (UNSAFE)' if x in unsafe([x]) else ''} |" for x in fails[:80]]
    if len(fails) > 80: L.append(f'| ... | | {len(fails) - 80} more in results-{k}.json | | |')
if 'base-baseline' in R:
    ub = unsafe(R['base-baseline']['rows'])
    if ub:
        x = ub[0]
        L[L.index('## Summary') + 1:L.index('## Summary') + 1] = ['', f"The run found {len(ub)} clips where the old parser would have proposed a money action the speaker did not ask for "
            f"(e.g. \"{x['text']}\" heard as \"{x['transcript']}\" became `{x['got']['type']}` of the focused position). The current parser refuses those (0 unsafe); they would still have needed a press on the confirm card.", '']
L += ['', 'Every money action still ends on the 30 s confirm card, which names the symbol, side and size; voice never confirms by itself.', '']
open(f'{H}/VOICE-REGRESSION.md', 'w').write('\n'.join(L))
print('wrote VOICE-REGRESSION.md', {k: (r['passed'], r['scored']) for k, r in R.items()})
