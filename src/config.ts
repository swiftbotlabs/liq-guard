// Worker URL, set at build time (scripts/set-api.mjs writes .env.production and the app.json whitelist).
export const API_BASE: string = (import.meta as any).env?.VITE_API_BASE || 'http://127.0.0.1:18787';
export const POLL_MS = 2_000;
