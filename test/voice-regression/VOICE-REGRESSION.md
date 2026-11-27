# Voice regression

Every voice command Liq Guard supports (10 commands, 3-4 spoken paraphrases each, 35 phrases) plus 5 negatives, synthesised with Kokoro in 5 voices (af_heart, af_bella, am_michael, bf_emma, bm_george) at speeds 0.85,1.0,1.15: **600 clips**, 16 kHz mono PCM16 (the G2 microphone format; every clip passes the Worker's `checkWav` guard). Each clip goes through speech-to-text and then the exact parser the Worker runs (`shared/intents.ts` `parseIntent`). A clip passes when the parsed intent equals the expected one exactly (type, amount, fraction, price, symbol); a negative passes when it stays `unknown`.

**ASR used here.** The deployed Worker uses Workers AI `whisper-large-v3-turbo`. Offline we run whisper.cpp: `large-v3-turbo` (q5_0, the same model family) on 3 voices at 1.0x, and the much smaller `base` (q8_0) on the full matrix as a pessimistic lower bound.

**Parsers.** `baseline` = `shared/intents.ts` at commit d510242 (before this run); `current` = after the fixes this run led to (ASR spellings `reduced`, `cutting`, `etherium`; and "close my <unknown word>" now returns unknown instead of closing the focused position).

Reproduce: `test/voice-regression/run.sh` (clips are regenerated; `manifest.json` lists every clip with its text, voice, speed, length and sha256).

## Summary

The run found 11 clips where the old parser would have proposed a money action the speaker did not ask for (e.g. "Close my ethereum." heard as "Close my etherium." became `close` of the focused position). The current parser refuses those (0 unsafe); they would still have needed a press on the confirm card.


| ASR | parser | clips | pass | unsafe (wrong money action) | negatives kept unknown |
|---|---|---|---|---|---|
| whisper.cpp base | baseline | 600 | 520/600 (87%) | 11 | 75/75 (100%) |
| whisper.cpp base | current | 600 | 543/600 (90%) | 0 | 75/75 (100%) |
| whisper.cpp turbo | baseline | 120 | 115/120 (96%) | 2 | 15/15 (100%) |
| whisper.cpp turbo | current | 120 | 116/120 (97%) | 0 | 15/15 (100%) |

## turbo ASR, current parser: per command

| command | pass |
|---|---|
| reduce half | 11/12 (92%) |
| reduce quarter | 12/12 (100%) |
| close | 12/12 (100%) |
| close eth | 8/9 (89%) |
| add 200 margin | 12/12 (100%) |
| add 500 margin | 9/9 (100%) |
| alert at 60k | 12/12 (100%) |
| btc alert at 59,500 | 9/9 (100%) |
| show eth | 7/9 (78%) |
| cancel | 9/9 (100%) |
| negative | 15/15 (100%) |

| voice | pass |
|---|---|
| af_heart | 40/40 (100%) |
| am_michael | 39/40 (98%) |
| bf_emma | 37/40 (92%) |

| speed | pass |
|---|---|
| 1 | 116/120 (97%) |

Failures (4): what was said, what the ASR heard, what the parser made of it. "unknown" asks the user again; nothing moves.

| voice | speed | said | heard | parsed |
|---|---|---|---|---|
| am_michael | 1 | Show ETH. | Show F. | unknown |
| bf_emma | 1 | Close half. | Close halfie. | unknown |
| bf_emma | 1 | Close the ETH position. | Close the ATH position. | unknown |
| bf_emma | 1 | Show ETH. | Joeth. | unknown |

## base ASR, current parser: per command

| command | pass |
|---|---|
| reduce half | 53/60 (88%) |
| reduce quarter | 55/60 (92%) |
| close | 51/60 (85%) |
| close eth | 40/45 (89%) |
| add 200 margin | 57/60 (95%) |
| add 500 margin | 41/45 (91%) |
| alert at 60k | 58/60 (97%) |
| btc alert at 59,500 | 45/45 (100%) |
| show eth | 28/45 (62%) |
| cancel | 40/45 (89%) |
| negative | 75/75 (100%) |

| voice | pass |
|---|---|
| af_heart | 112/120 (93%) |
| af_bella | 112/120 (93%) |
| am_michael | 113/120 (94%) |
| bf_emma | 98/120 (82%) |
| bm_george | 108/120 (90%) |

| speed | pass |
|---|---|
| 1 | 186/200 (93%) |
| 0.85 | 173/200 (86%) |
| 1.15 | 184/200 (92%) |

Failures (57): what was said, what the ASR heard, what the parser made of it. "unknown" asks the user again; nothing moves.

| voice | speed | said | heard | parsed |
|---|---|---|---|---|
| af_heart | 0.85 | Close it. | A close-it. | unknown |
| af_heart | 0.85 | Close ether. | A close ether. | unknown |
| af_heart | 0.85 | Show ETH. | You show "F." | unknown |
| af_heart | 0.85 | No. | Now. | unknown |
| af_heart | 1 | Show ETH. | Show F. | unknown |
| af_heart | 1 | No. | Now. | unknown |
| af_heart | 1.15 | Add five hundred margin. | at 500 Margin. | unknown |
| af_heart | 1.15 | Show ETH. | Show F. | unknown |
| af_bella | 0.85 | Show ETH. | Show F. | unknown |
| af_bella | 1 | Cut it in half. | Cutter in half. | unknown |
| af_bella | 1 | Show ETH. | Show F. | unknown |
| af_bella | 1 | No. | Now. | unknown |
| af_bella | 1.15 | Cut it in half. | Cutter in half. | unknown |
| af_bella | 1.15 | Add five hundred margin. | at 500 Margin. | unknown |
| af_bella | 1.15 | Show ETH. | Show F. | unknown |
| af_bella | 1.15 | No. | Now. | unknown |
| am_michael | 0.85 | Close half. | Glows have. | unknown |
| am_michael | 0.85 | Close. | It glows. | unknown |
| am_michael | 0.85 | Close it. | A close hit. | unknown |
| am_michael | 0.85 | Show ETH. | Show F. | unknown |
| am_michael | 1 | Show ETH. | Show F. | unknown |
| am_michael | 1.15 | Add 200 USDT margin. | at 200 Us Margin. | unknown |
| am_michael | 1.15 | Show ETH. | Show F. | unknown |
| bf_emma | 0.85 | Trim a quarter. | Dreamer quarter. | unknown |
| bf_emma | 0.85 | Close it. | A close-it. | unknown |
| bf_emma | 0.85 | Flatten. | If Latin. | unknown |
| bf_emma | 0.85 | Close ether. | A close ether. | unknown |
| bf_emma | 0.85 | Close my ethereum. | Close my etheriums. | unknown |
| bf_emma | 0.85 | Add two hundred margin. | Add 200 margins. | unknown |
| bf_emma | 0.85 | Add two hundred to margin. | Add 200 to margins. | unknown |
| bf_emma | 0.85 | Add five hundred margin. | Add 500 margins. | unknown |
| bf_emma | 0.85 | Top up five hundred. | Top up 500i. | unknown |
| bf_emma | 0.85 | Alert at sixty k. | I'll learn at 60k. | unknown |
| bf_emma | 0.85 | Alert at 60k. | I'll learn at 60k. | unknown |
| bf_emma | 0.85 | Show ETH. | Who show Earth? | unknown |
| bf_emma | 0.85 | Cancel. | It can't silly. | unknown |
| bf_emma | 1 | Reduce half. | Reduce Haarfer. | unknown |
| bf_emma | 1 | Close half. | Close halfi. | unknown |
| bf_emma | 1 | Trim a quarter. | Trimmer Quarter. | unknown |
| bf_emma | 1 | Close the ETH position. | Close the ATH position. | unknown |
| bf_emma | 1 | Show ETH. | Show Earth. | unknown |
| bf_emma | 1.15 | Reduce half. | Reduce Haarfer. | unknown |
| bf_emma | 1.15 | Trim a quarter. | Trimmer Quarter. | unknown |
| bf_emma | 1.15 | Close the ETH position. | Close the ATH position. | unknown |
| bf_emma | 1.15 | Show ETH. | Show Earth. | unknown |
| bm_george | 0.85 | Close half. | Glow's half a. | unknown |
| bm_george | 0.85 | Trim a quarter. | Dream a quarter. | unknown |
| bm_george | 0.85 | Close. | Closer. | unknown |
| bm_george | 0.85 | Flatten. | Flattern-oo. | unknown |
| bm_george | 0.85 | Show ETH. | Show Earth. | unknown |
| bm_george | 1 | Close. | Closer. | unknown |
| bm_george | 1 | Show ETH. | Show Earth. | unknown |
| bm_george | 1 | Show ether. | Show Ethan. | unknown |
| bm_george | 1.15 | Trim a quarter. | Trimmer quarter. | unknown |
| bm_george | 1.15 | Close. | Closer. | unknown |
| bm_george | 1.15 | Show ETH. | Show Earth. | unknown |
| bm_george | 1.15 | Show ethereum. | Show Aetherium. | unknown |

Every money action still ends on the 30 s confirm card, which names the symbol, side and size; voice never confirms by itself.
