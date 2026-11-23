# Liq Guard price relay

A read-only forwarder for one public Binance USDT-M futures **testnet** endpoint, `GET /fapi/v1/premiumIndex?symbol=BTCUSDT|ETHUSDT`.
The testnet refuses requests from Cloudflare Worker egress, so the Worker asks this relay, hosted anywhere with ordinary egress.

- Needs `x-relay-token` equal to `RELAY_TOKEN` (32+ chars); `GET /health` is open (use it to wake a sleeping free instance).
- Forwards nothing else: no signed endpoints, no POST, no other symbols or query parameters. Holds no keys. 1 s cache.
- Run: `RELAY_TOKEN=... PORT=10000 node server.mjs`. Tests: `node --test relay.test.mjs` (offline, fake upstream).
