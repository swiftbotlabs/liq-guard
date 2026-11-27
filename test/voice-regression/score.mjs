// score.mjs <base|turbo>: transcript -> parseIntent (the exact parser the Worker runs after Whisper) -> pass/fail vs expected.
// Writes results-<model>.json and prints per-command / per-voice / per-speed pass rates. Exit 1 if any clip lacks a transcript.
import { readFileSync, writeFileSync } from 'node:fs';
const H = new URL('.', import.meta.url).pathname;
const model = process.argv[2];
const parser = process.argv[3] ?? 'current'; // current = shared/intents.ts; baseline = intents.ts at commit d510242 (before this regression)
const { parseIntent } = await import(parser === 'baseline' ? './build/intents-baseline.mjs' : './build/intents.mjs');
const man = JSON.parse(readFileSync(H + 'manifest.json')).clips;
const tr = JSON.parse(readFileSync(H + `transcripts-${model}.json`));
const canon = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => ((a[k] = o[k]), a), {}));
const rows = [];
let missing = 0;
for (const c of man) {
  const t = tr[`${c.clip}|${c.sha256}`];
  if (t === undefined) { missing++; continue; }
  const got = parseIntent(t);
  const pass = c.cmd === 'negative' ? got.type === 'unknown' : canon(got) === canon(c.expect);
  rows.push({ ...c, transcript: t, got, pass });
}
if (missing) { console.error(`missing transcripts: ${missing}`); }
if (!rows.length) { console.error('0 clips scored'); process.exit(1); }
const tab = (k) => { const m = {}; for (const r of rows) { const g = (m[r[k]] ??= [0, 0]); g[1]++; if (r.pass) g[0]++; } return m; };
const out = { model, parser, scored: rows.length, missing, passed: rows.filter((r) => r.pass).length, byCmd: tab('cmd'), byVoice: tab('voice'), bySpeed: tab('speed'), rows };
writeFileSync(H + `results-${model}-${parser}.json`, JSON.stringify(out, null, 1));
console.log(`${model} ${parser}: ${out.passed}/${out.scored} pass${missing ? `, ${missing} missing` : ''}`);
for (const r of rows.filter((r) => !r.pass)) console.log(`FAIL ${r.voice} ${r.speed} [${r.cmd}] said ${JSON.stringify(r.text)} heard ${JSON.stringify(r.transcript)} -> ${JSON.stringify(r.got)}`);
process.exit(model === 'base' && missing ? 1 : 0); // base must cover the full matrix; turbo runs on a subset
