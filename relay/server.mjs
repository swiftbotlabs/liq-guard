// Liq Guard price relay: a tiny forwarder for PUBLIC Binance USDT-M futures TESTNET mark prices, for Worker hosts whose egress
// the testnet refuses. Read-only: it forwards ONLY GET /fapi/v1/premiumIndex?symbol=<allowlisted>, ONLY with the right
// x-relay-token, adds no keys and never signs anything. Zero dependencies (Node >= 20). A 1 s cache spares the testnet.
import http from 'node:http';
import crypto from 'node:crypto';

const UPSTREAM = process.env.UPSTREAM || 'https://testnet.binancefuture.com';
const TOKEN = process.env.RELAY_TOKEN || '';
const PORT = Number(process.env.PORT || 10000);
const SYMBOLS = new Set((process.env.SYMBOLS || 'BTCUSDT,ETHUSDT').split(','));
const CACHE_MS = 1000;

if (TOKEN.length < 32) { console.error('RELAY_TOKEN missing or shorter than 32 chars; refusing to start'); process.exit(1); }
if (!/^https:\/\/[a-z0-9.-]+$/.test(UPSTREAM)) { console.error('UPSTREAM must be a bare https origin'); process.exit(1); }
const tokenOk = (t) => typeof t === 'string' && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
const cache = new Map(); // symbol -> {at, status, body}

async function upstream(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const r = await fetch(`${UPSTREAM}/fapi/v1/premiumIndex?symbol=${symbol}`, { signal: AbortSignal.timeout(5000) });
  const body = Buffer.from(await r.arrayBuffer());
  if (body.length > 64 * 1024) throw new Error('too large');
  const out = { at: Date.now(), status: r.status, body };
  if (r.ok) cache.set(symbol, out);
  return out;
}

export const server = http.createServer(async (req, res) => {
  const send = (code, msg, type = 'text/plain') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(msg); };
  let url;
  try { url = new URL(req.url, 'http://relay'); } catch { return send(400, 'bad url'); }
  if (req.method === 'GET' && url.pathname === '/health') return send(200, 'ok');
  if (req.method !== 'GET' || url.pathname !== '/fapi/v1/premiumIndex') return send(404, 'not found');
  if (!tokenOk(req.headers['x-relay-token'])) return send(401, 'unauthorized');
  const keys = [...url.searchParams.keys()];
  const symbol = url.searchParams.get('symbol') || '';
  if (keys.length !== 1 || keys[0] !== 'symbol' || !SYMBOLS.has(symbol)) return send(400, 'symbol not allowed');
  try {
    const u = await upstream(symbol);
    send(u.status, u.body, 'application/json');
  } catch { send(502, 'upstream unreachable'); }
});
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, () => console.log(`liq-guard price relay on :${PORT} -> ${new URL(UPSTREAM).host}`));
}
