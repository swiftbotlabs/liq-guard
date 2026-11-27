// Text-level check: does every scripted phrase parse to its expected intent? (separates parser gaps from ASR errors)
import { readFileSync } from 'node:fs';
import { parseIntent } from './build/intents.mjs'; // run.sh builds it from shared/intents.ts
const P = JSON.parse(readFileSync(new URL('./phrases.json', import.meta.url)));
let bad = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const c of P.commands) for (const s of c.say) { const r = parseIntent(s); if (!eq(r, c.expect)) { bad++; console.log('TEXT FAIL', JSON.stringify(s), JSON.stringify(r)); } }
for (const s of P.negatives) { const r = parseIntent(s); if (r.type !== 'unknown') { bad++; console.log('NEG FAIL', s, JSON.stringify(r)); } }
console.log('text-level failures:', bad); process.exit(bad ? 1 : 0);
