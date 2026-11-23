// Offline tests: a fake upstream on an ephemeral port; the relay under test on another.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let up, relay, base, upHits = 0, upFail = false;
const TOKEN = 'x'.repeat(40);
before(async () => {
  up = http.createServer((req, res) => {
    upHits++;
    if (upFail) { res.writeHead(403); return res.end('<html>blocked</html>'); }
    const s = new URL(req.url, 'http://u').searchParams.get('symbol');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ symbol: s, markPrice: '63000.1' }));
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  // the relay requires an https origin for UPSTREAM in production; tests point it at http via a loader-free override
  process.env.RELAY_TOKEN = TOKEN;
  process.env.UPSTREAM = 'https://placeholder.invalid';
  const mod = await import('./server.mjs?t=' + Date.now());
  relay = mod.server;
  // swap global fetch so the relay's upstream calls land on the fake server
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, init) => realFetch(String(u).replace('https://placeholder.invalid', `http://127.0.0.1:${up.address().port}`), init);
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${relay.address().port}`;
});
after(() => { relay.close(); up.close(); });

const get = (path, token = TOKEN) => fetch(base + path, { headers: token ? { 'x-relay-token': token } : {} });

test('health needs no token', async () => { assert.equal((await get('/health', null)).status, 200); });
test('no token -> 401', async () => { assert.equal((await get('/fapi/v1/premiumIndex?symbol=BTCUSDT', null)).status, 401); });
test('wrong token -> 401', async () => { assert.equal((await get('/fapi/v1/premiumIndex?symbol=BTCUSDT', 'y'.repeat(40))).status, 401); });
test('other path -> 404 (no signed endpoints)', async () => { assert.equal((await get('/fapi/v2/positionRisk?symbol=BTCUSDT')).status, 404); });
test('POST -> 404', async () => { assert.equal((await fetch(base + '/fapi/v1/premiumIndex?symbol=BTCUSDT', { method: 'POST', headers: { 'x-relay-token': TOKEN } })).status, 404); });
test('symbol not allowlisted -> 400', async () => { assert.equal((await get('/fapi/v1/premiumIndex?symbol=DOGEUSDT')).status, 400); });
test('extra params -> 400', async () => { assert.equal((await get('/fapi/v1/premiumIndex?symbol=BTCUSDT&timestamp=1')).status, 400); });
test('good request forwards JSON, then caches', async () => {
  const before = upHits;
  const r = await get('/fapi/v1/premiumIndex?symbol=ETHUSDT');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).markPrice, '63000.1');
  await get('/fapi/v1/premiumIndex?symbol=ETHUSDT');
  assert.equal(upHits - before, 1);
});
test('upstream refusal passes through as non-200', async () => {
  upFail = true;
  const r = await get('/fapi/v1/premiumIndex?symbol=BTCUSDT');
  upFail = false;
  assert.equal(r.status, 403);
});
