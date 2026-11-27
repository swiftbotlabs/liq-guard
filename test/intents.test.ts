import { describe, expect, it } from 'vitest';
import { normalise, parseIntent, parseNumberAt } from '../shared/intents';

const num = (s: string) => parseNumberAt(s.split(' '), 0)?.value;

describe('number words', () => {
  it.each([
    ['60000', 60000], ['60 k', 60000], ['59.5 k', 59500], ['sixty thousand', 60000], ['two hundred', 200],
    ['ninety one k', 91000], ['fifty nine point five k', 59500], ['a thousand', 1000], ['twenty five', 25],
    ['one hundred and fifty', 150], ['three thousand two hundred', 3200],
  ])('%s -> %d', (s, v) => expect(num(s)).toBe(v));
});

describe('intents', () => {
  it.each([
    ['Reduce half.', { type: 'reduce', fraction: 0.5 }],
    ['reduce by half', { type: 'reduce', fraction: 0.5 }],
    ['Close half of my bitcoin', { type: 'reduce', fraction: 0.5, symbol: 'BTCUSDT' }],
    ['cut it in half', { type: 'reduce', fraction: 0.5 }],
    ['reduce 25%', { type: 'reduce', fraction: 0.25 }],
    ['reduce twenty five percent', { type: 'reduce', fraction: 0.25 }],
    ['trim a quarter', { type: 'reduce', fraction: 0.25 }],
    ['close 100 percent', { type: 'close' }],
    ['Close.', { type: 'close' }],
    ['close it', { type: 'close' }],
    ['Close the ETH position', { type: 'close', symbol: 'ETHUSDT' }],
    ['flatten', { type: 'close' }],
    ['close my position', { type: 'close' }],
    ['Close my etherium.', { type: 'close', symbol: 'ETHUSDT' }],
    ['reduced by a quarter', { type: 'reduce', fraction: 0.25 }],
    ['Cutting in half.', { type: 'reduce', fraction: 0.5 }],
    ['Add 200 margin.', { type: 'add_margin', amount: 200 }],
    ['add two hundred to margin', { type: 'add_margin', amount: 200 }],
    ['Move $500 from spot to margin', { type: 'add_margin', amount: 500 }],
    ['top up 300 usdt', { type: 'add_margin', amount: 300 }],
    ['Alert at 60k.', { type: 'alert', price: 60000 }],
    ['alert me at sixty thousand', { type: 'alert', price: 60000 }],
    ['Set an alert at 59,500 on Bitcoin', { type: 'alert', price: 59500, symbol: 'BTCUSDT' }],
    ['ETH alert at 3,050', { type: 'alert', price: 3050, symbol: 'ETHUSDT' }],
    ['show eth', { type: 'focus', symbol: 'ETHUSDT' }],
    ['Cancel.', { type: 'cancel' }],
    ['no', { type: 'cancel' }],
  ])('%s', (text, want) => expect(parseIntent(text)).toEqual(want));

  it('unknown and hostile input stays unknown and bounded', () => {
    expect(parseIntent('what is the weather').type).toBe('unknown');
    expect(parseIntent('').type).toBe('unknown');
    expect(parseIntent('add margin').type).toBe('unknown'); // no amount: never guess money
    expect(parseIntent('alert').type).toBe('unknown');
    expect(parseIntent('close my dogecoin').type).toBe('unknown'); // never guess which position to close
    expect(parseIntent('close the window').type).toBe('unknown');
    const big = 'reduce half '.repeat(10_000);
    expect(normalise(big).length).toBeLessThanOrEqual(200);
    expect(parseIntent('<script>alert(1)</script>').type).not.toBe('add_margin');
    expect(parseIntent(undefined as unknown as string).type).toBe('unknown');
  });
});
