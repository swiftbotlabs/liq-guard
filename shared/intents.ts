// Voice intents: a short transcript -> one structured intent. Regex + a small number-word parser; no LLM.
// Everything that moves money ends on the confirm card; voice never confirms by itself.

export type Intent =
  | { type: 'reduce'; fraction: number; symbol?: string } // 0 < fraction < 1
  | { type: 'close'; symbol?: string }
  | { type: 'add_margin'; amount: number; symbol?: string } // USDT
  | { type: 'alert'; price: number; symbol?: string }
  | { type: 'focus'; symbol: string }
  | { type: 'cancel' }
  | { type: 'unknown'; text: string };

export const MAX_TRANSCRIPT = 200;

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, a: 1, an: 1,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, k: 1000, grand: 1000, million: 1_000_000, m: 1_000_000 };

const SYMBOLS: [RegExp, string][] = [
  [/\b(btc|bitcoin|bit coin)\b/, 'BTCUSDT'],
  [/\b(eth|ether|ethereum|etherium|etherum|e t h)\b/, 'ETHUSDT'], // + common ASR spellings
];

/** Normalise a transcript: lower case, digits glued to k/m, punctuation out, currency words out. */
export function normalise(raw: string): string {
  let s = String(raw ?? '').slice(0, MAX_TRANSCRIPT).toLowerCase();
  s = s.replace(/[‘’']/g, '');
  s = s.replace(/(\d),(\d{3})/g, '$1$2').replace(/(\d),(\d{3})/g, '$1$2');
  s = s.replace(/\$\s*/g, ' ');
  s = s.replace(/(\d+(?:\.\d+)?)\s*(k|m)\b/g, '$1 $2');
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, '$1 percent');
  s = s.replace(/[^a-z0-9.\s-]/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/-/g, ' ');
  s = s.replace(/\b(usdt|usd|dollars?|bucks|tether)\b/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Parse the first number phrase in `words` starting at index i. Supports digits ("60000", "59.5"), digits with scale
 * ("60 k", "1.2 thousand"), and number words ("sixty thousand", "two hundred", "ninety one k", "fifty nine point five k").
 */
export function parseNumberAt(words: string[], i: number): { value: number; end: number } | null {
  let total = 0;
  let current = 0;
  let seen = false;
  let j = i;
  let decimal: string | null = null;
  for (; j < words.length; j++) {
    const w = words[j];
    if (/^\d+(\.\d+)?$/.test(w)) {
      if (seen && current !== 0) break;
      current += parseFloat(w);
      seen = true;
      continue;
    }
    if (w === 'point' && seen && j + 1 < words.length) {
      const d = words[j + 1];
      const dv = UNITS[d];
      if (dv !== undefined && dv < 10) {
        decimal = (decimal ?? '') + String(dv);
        j++;
        // allow "point five five"
        while (j + 1 < words.length && UNITS[words[j + 1]] !== undefined && UNITS[words[j + 1]] < 10) {
          decimal += String(UNITS[words[j + 1]]);
          j++;
        }
        continue;
      }
      break;
    }
    if (UNITS[w] !== undefined && !(w === 'a' || w === 'an') ) {
      current += UNITS[w];
      seen = true;
      continue;
    }
    if ((w === 'a' || w === 'an') && j + 1 < words.length && SCALES[words[j + 1]] && !seen) {
      current = 1;
      seen = true;
      continue;
    }
    if (TENS[w] !== undefined) {
      current += TENS[w];
      seen = true;
      continue;
    }
    if (SCALES[w] !== undefined && seen) {
      const scale = SCALES[w];
      if (decimal !== null) {
        current = current + parseFloat('0.' + decimal);
        decimal = null;
      }
      if (scale === 100) current = (current || 1) * 100;
      else {
        total += (current || 1) * scale;
        current = 0;
      }
      continue;
    }
    if (w === 'and' && seen) continue;
    break;
  }
  if (!seen) return null;
  let value = total + current;
  if (decimal !== null) value += parseFloat('0.' + decimal);
  // trim a trailing "and" we may have swallowed
  while (j > i && words[j - 1] === 'and') j--;
  return { value, end: j };
}

function findNumberAfter(words: string[], from: number): { value: number; end: number; start: number } | null {
  for (let i = from; i < words.length; i++) {
    const r = parseNumberAt(words, i);
    if (r) return { ...r, start: i };
  }
  return null;
}

function symbolOf(s: string): string | undefined {
  for (const [re, sym] of SYMBOLS) if (re.test(s)) return sym;
  return undefined;
}

const FRACTION_WORDS: [RegExp, number][] = [
  [/\b(half|halve|in two|fifty percent|50 percent)\b/, 0.5],
  [/\b(a |one )?(third)\b/, 1 / 3],
  [/\b(a |one )?(quarter)\b/, 0.25],
  [/\b(three quarters)\b/, 0.75],
];

export function parseIntent(raw: string): Intent {
  const s = normalise(raw);
  const words = s.split(' ').filter(Boolean);
  const symbol = symbolOf(s);
  const withSym = <T extends object>(o: T): T => (symbol ? { ...o, symbol } : o);
  if (!s) return { type: 'unknown', text: '' };

  if (/^(no|nope|cancel|stop|never mind|nevermind|abort|back)\b/.test(s) && !/\balert\b/.test(s)) return { type: 'cancel' };

  // alerts: "alert at 60k", "alert me at sixty thousand", "set an alert 59.5k", "ping me at 60000", "price alert 3000 eth"
  if (/\b(alert|alarm|ping me|notify me|tell me|warn me)\b/.test(s)) {
    const idx = words.findIndex((w) => /^(alert|alarm|ping|notify|tell|warn)$/.test(w));
    const n = findNumberAfter(words, Math.max(0, idx));
    if (n && n.value > 0) return withSym({ type: 'alert', price: n.value } as Intent);
    return { type: 'unknown', text: s };
  }

  // margin: "add 200 margin", "add two hundred to margin", "move 500 from spot to margin", "top up 300"
  if (/\b(margin|top up|topup|collateral)\b/.test(s) && /\b(add|move|put|top|transfer|increase|deposit)\b/.test(s)) {
    const n = findNumberAfter(words, 0);
    if (n && n.value > 0) return withSym({ type: 'add_margin', amount: n.value } as Intent);
    return { type: 'unknown', text: s };
  }

  // close: "close", "close it", "close all", "flatten", "close the btc position" (but not "close half")
  const isReduceWord = /\b(reduce|reduced|reducing|cut|cutting|trim|close|sell|take off|derisk|de risk)\b/.test(s);
  if (/\b(flatten|close (it|all|everything|the position|position|out)|exit (the )?position)\b/.test(s) || s === 'close' ||
      (/^close\b/.test(s) && !/\b(half|percent|third|quarter|\d)\b/.test(s) && !/\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/.test(s))) {
    // never guess which position: "close my dogecoin" (or an ASR-mangled symbol) is unknown, not "close the focused one"
    const CLOSE_OK = /^(close|it|all|everything|the|my|position|positions|out|now|please|flatten|exit|btc|bitcoin|bit|coin|eth|ether|ethereum|etherium|etherum|e|t|h|long|short)$/;
    if (words.some((w) => !CLOSE_OK.test(w))) return { type: 'unknown', text: s };
    return withSym({ type: 'close' } as Intent);
  }
  if (isReduceWord) {
    for (const [re, f] of FRACTION_WORDS) if (re.test(s)) return withSym({ type: 'reduce', fraction: f } as Intent);
    const pIdx = words.indexOf('percent');
    if (pIdx > 0) {
      const n = findNumberAfter(words, 0);
      if (n && n.end <= pIdx + 1) {
        const pct = n.value;
        if (pct >= 100) return withSym({ type: 'close' } as Intent);
        if (pct > 0) return withSym({ type: 'reduce', fraction: pct / 100 } as Intent);
      }
    }
    return { type: 'unknown', text: s };
  }

  if (symbol && /\b(show|next|switch|go to|open|focus)\b|^(btc|eth|bitcoin|ether|ethereum)$/.test(s)) return { type: 'focus', symbol };

  return { type: 'unknown', text: s };
}
