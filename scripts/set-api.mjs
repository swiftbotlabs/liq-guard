// Point the app at a deployed Worker: writes .env.production (VITE_API_BASE) and the app.json network whitelist.
// Usage: node scripts/set-api.mjs https://liq-guard.<your-subdomain>.workers.dev
import { readFileSync, writeFileSync } from 'node:fs';

const raw = process.argv[2] ?? '';
let u;
try { u = new URL(raw); } catch { console.error('usage: node scripts/set-api.mjs https://<worker-host>'); process.exit(2); }
if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
  console.error('need a bare https origin, e.g. https://liq-guard.example.workers.dev'); process.exit(2);
}
const origin = u.origin;
writeFileSync('.env.production', `VITE_API_BASE=${origin}\n`);
const app = JSON.parse(readFileSync('app.json', 'utf8'));
const net = app.permissions.find((p) => p.name === 'network');
net.whitelist = [origin];
writeFileSync('app.json', JSON.stringify(app, null, 2) + '\n');
console.log('API base set to', origin);
