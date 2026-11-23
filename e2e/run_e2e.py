# End-to-end in SIM mode against a local Worker (wrangler dev) and the preview harness (vite preview).
# position -> price move -> alert -> voice "reduce half" -> confirm -> reduced; then add margin from the danger default,
# API idempotency replay, and bad-input checks. Writes e2e/out/log.json and screenshots in e2e/out/.
# Usage: python -u e2e/run_e2e.py <worker_url> <preview_url> [<live_nokey_worker_url>]
import json, os, sys, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

W, P = sys.argv[1].rstrip('/'), sys.argv[2].rstrip('/')
LIVE_NOKEY = sys.argv[3].rstrip('/') if len(sys.argv) > 3 else None
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
os.makedirs(OUT, exist_ok=True)
log, fails = [], []


def step(name, ok, **info):
    log.append({'step': name, 'ok': bool(ok), **info})
    print(('PASS ' if ok else 'FAIL ') + name, json.dumps(info)[:300], flush=True)
    if not ok:
        fails.append(name)


def http(method, url, body=None, headers=None, raw=None):
    h = dict(headers or {})
    data = None
    if raw is not None:
        data = raw
    elif body is not None:
        data = json.dumps(body).encode()
        h['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


# ---------- API level ----------
st, h = http('GET', W + '/api/health')
step('health', st == 200 and h.get('mode') == 'SIM', status=st, body=h)
st, s = http('POST', W + '/api/session', {})
sess = s.get('session', '')
step('session', st == 200 and len(sess) == 32, status=st)
H = {'X-Session': sess}
st, d = http('GET', W + '/api/state', headers=H)
btc = next((p for p in d.get('positions', []) if p['symbol'] == 'BTCUSDT'), None)
step('state: SIM BTC long marked to live testnet price', st == 200 and d.get('mode') == 'SIM' and btc and btc['mark'] > 0 and not d['stale'],
     mark=btc and btc['mark'], liq=btc and round(btc['liq'], 1), liqDist=btc and round(btc['liqDist'], 4))

# idempotency at the API level
st, pr = http('POST', W + '/api/action/propose', {'kind': 'reduce', 'symbol': 'ETHUSDT', 'fraction': 0.5}, H)
step('propose reduce ETH', st == 200 and pr.get('token'), title=pr.get('title'), lines=pr.get('lines'))
key = 'e2e-idem-' + str(int(time.time()))
st1, r1 = http('POST', W + '/api/action/confirm', {'token': pr['token']}, {**H, 'Idempotency-Key': key})
st2, r2 = http('POST', W + '/api/action/confirm', {'token': pr['token']}, {**H, 'Idempotency-Key': key})
st3, r3 = http('POST', W + '/api/action/confirm', {'token': pr['token']}, {**H, 'Idempotency-Key': key + 'x'})
step('confirm executes once; same key replays the same result', st1 == 200 and st2 == 200 and r2.get('replay') and r2['ref'] == r1['ref'], ref=r1.get('ref'), summary=r1.get('summary'))
step('used token with a new key is refused', st3 == 409 and r3.get('error') == 'bad_token', status=st3, body=r3)
st, d2 = http('GET', W + '/api/state', headers=H)
eth = next((p for p in d2['positions'] if p['symbol'] == 'ETHUSDT'), None)
step('ETH reduced exactly once (3 -> 1.5)', eth and abs(eth['qty'] - 1.5) < 1e-9, qty=eth and eth['qty'])

# bad input
st, b = http('GET', W + '/api/state')
step('no session -> 401', st == 401, status=st)
st, b = http('POST', W + '/api/action/propose', raw=b'{not json', headers={**H, 'Content-Type': 'application/json'})
step('bad JSON -> 400', st == 400 and b.get('error') == 'bad_json', status=st)
st, b = http('POST', W + '/api/intent', raw=b'{"text":"' + b'a' * 10000 + b'"}', headers={**H, 'Content-Type': 'application/json'})
step('oversized JSON -> 413', st == 413, status=st)
st, b = http('POST', W + '/api/action/propose', {'kind': 'reduce', 'symbol': 'BTCUSDT', 'fraction': 2}, H)
step('reduce fraction 2 -> refused (reduce only)', st == 400 and b.get('error') == 'bad_fraction', status=st)
st, b = http('POST', W + '/api/action/propose', {'kind': 'buy', 'symbol': 'BTCUSDT'}, H)
step('open/increase action -> refused', st == 400 and b.get('error') == 'bad_kind', status=st)
st, b = http('POST', W + '/api/action/propose', {'kind': 'add_margin', 'symbol': 'BTCUSDT', 'amount': 50000}, H)
step('margin above per-action cap -> 403', st == 403 and b.get('error') == 'cap_margin', status=st)
st, b = http('POST', W + '/api/action/propose', {'kind': 'close', 'symbol': 'SOLUSDT'}, H)
step('symbol not on allowlist -> 400', st == 400 and b.get('error') == 'bad_symbol', status=st)
st, b = http('POST', W + '/api/sim/shock', {'pct': -0.5}, H)
step('shock beyond 20% -> 400', st == 400, status=st)
st, b = http('POST', W + '/api/asr', raw=b'\x00' * 2000, headers={**H, 'Content-Type': 'application/octet-stream'})
# local: no Workers AI binding -> 503; deployed: 2,000 zero bytes are rejected by the content check -> 400. Never a fake transcript.
step('asr on junk audio -> 503 (local, no AI) or 400 bad_audio (deployed)',
     (st == 503 and b.get('error') == 'asr_unavailable') or (st == 400 and b.get('error') == 'bad_audio'), status=st, error=b.get('error'))
st, b = http('POST', W + '/api/asr', raw=b'\x00' * 400_000, headers={**H, 'Content-Type': 'application/octet-stream'})
step('asr body over 10 s -> 413 or 503', st in (413, 503), status=st)
st, b = http('POST', W + '/api/action/confirm', {'token': 'x' * 32}, {**H, 'Idempotency-Key': 'shortkey1'})
step('unknown confirm token -> 409', st == 409, status=st)

if LIVE_NOKEY:
    st, s2 = http('POST', LIVE_NOKEY + '/api/session', {})
    step('LIVE mode without pairing code -> 403', st == 403 and s2.get('error') == 'pair_required', status=st)

# ---------- glasses UI (preview harness) against the same Worker ----------
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path=os.environ.get('CHROME') or None, headless=True, args=['--no-sandbox', '--disable-gpu'])
    pg = br.new_page(viewport={'width': 576, 'height': 288}, device_scale_factor=1)
    pg.on('pageerror', lambda e: step('pageerror', False, err=str(e)))
    pg.goto(f'{P}/preview.html?live=1&poll=0&chrome=0&api={W}')
    pg.wait_for_function('document.body.dataset.ready', timeout=15000)
    sid = pg.evaluate("localStorage.getItem('lg.session')")
    UH = {'X-Session': sid}

    def shot(n):
        pg.screenshot(path=f'{OUT}/{n}.png', clip={'x': 0, 'y': 0, 'width': 576, 'height': 288})

    def page_text():
        return pg.evaluate("JSON.stringify(window.lg.page())")

    def screen():
        return pg.evaluate('window.lg.ctl.screen')

    shot('01-glance-calm')
    txt = page_text()
    step('UI glance shows SIM label and BTC LONG', 'SIM' in txt and 'BTC LONG' in txt, screen=screen())

    st, d = http('GET', W + '/api/state', headers=UH)
    mark = d['positions'][0]['mark']
    lvl = int(round(mark * 0.98 / 100) * 100)
    pg.evaluate(f"window.lg.text('alert at {lvl}')")
    pg.wait_for_function("window.lg.ctl.screen === 'result'", timeout=8000)
    shot('02-alert-set')
    step('voice text "alert at N" sets a price alert (no confirm needed, no money)', 'ALERT SET' in page_text(), level=lvl)
    pg.wait_for_function("window.lg.ctl.screen === 'glance'", timeout=8000)

    # the price moves: labelled SIM shock of -7% on the live testnet mark
    st, b = http('POST', W + '/api/sim/shock', {'pct': -0.07, 'rampSec': 0}, UH)
    step('SIM shock -7% (labelled demo control)', st == 200, status=st)
    time.sleep(1.2)
    pg.evaluate('window.lg.tick()')
    pg.wait_for_function("window.lg.ctl.screen === 'alert'", timeout=8000)
    shot('03-alert-liq-danger')
    t = page_text()
    step('alert screen pops for liquidation danger', 'liquidation under 5%' in t, alert=pg.evaluate('window.lg.ctl.alert && window.lg.ctl.alert.text'))
    pg.evaluate("window.lg.input('down')")  # swipe = dismiss
    pg.wait_for_function("window.lg.ctl.screen === 'glance'", timeout=8000)
    pg.evaluate('window.lg.tick()')
    time.sleep(0.3)
    shot('04-glance-danger')
    t = page_text()
    step('glance in danger: boxed liq line, add-margin default', 'add ' in t and 'margin' in t and 'LIQ' in t, pick=pg.evaluate("window.lg.page().boxes.find(b=>b.name==='pick').content"))

    st, before = http('GET', W + '/api/state', headers=UH)
    q0 = next(p for p in before['positions'] if p['symbol'] == 'BTCUSDT')['qty']
    # voice: "reduce half" (typed path = the exact code path after Whisper)
    pg.evaluate("window.lg.text('reduce half')")
    pg.wait_for_function("window.lg.ctl.screen === 'confirm'", timeout=8000)
    shot('05-confirm-reduce')
    t = page_text()
    step('voice "reduce half" -> confirm card, nothing executed yet', 'Reduce BTC LONG by 50%?' in t, title=pg.evaluate('window.lg.ctl.proposal.title'))
    st, mid = http('GET', W + '/api/state', headers=UH)
    step('position unchanged while the card is open', next(p for p in mid['positions'] if p['symbol'] == 'BTCUSDT')['qty'] == q0, qty=q0)
    pg.evaluate("window.lg.input('press')")  # YES
    pg.wait_for_function("window.lg.ctl.screen === 'result'", timeout=8000)
    shot('06-result-reduced')
    st, after = http('GET', W + '/api/state', headers=UH)
    q1 = next(p for p in after['positions'] if p['symbol'] == 'BTCUSDT')['qty']
    step('one press -> reduced by half', abs(q1 - q0 / 2) < 1e-9, before=q0, after=q1, result=pg.evaluate('window.lg.ctl.result.summary'))

    # NO path: swipe cancels
    pg.wait_for_function("window.lg.ctl.screen === 'glance'", timeout=8000)
    pg.evaluate("window.lg.text('close')")
    pg.wait_for_function("window.lg.ctl.screen === 'confirm'", timeout=8000)
    pg.evaluate("window.lg.input('down')")
    pg.wait_for_function("window.lg.ctl.screen === 'glance'", timeout=8000)
    st, after2 = http('GET', W + '/api/state', headers=UH)
    step('swipe on confirm = NO: position untouched', next(p for p in after2['positions'] if p['symbol'] == 'BTCUSDT')['qty'] == q1)

    # danger default: press -> add margin -> press -> liq moves away
    pg.evaluate('window.lg.tick()')
    time.sleep(0.3)
    sug = pg.evaluate("window.lg.page().boxes.find(b=>b.name==='pick').content")
    liq0 = next(p for p in after2['positions'] if p['symbol'] == 'BTCUSDT')['liqDist']
    pg.evaluate("window.lg.ctl.pick = 0; window.lg.input('press')")
    pg.wait_for_function("window.lg.ctl.screen === 'confirm'", timeout=8000)
    shot('07-confirm-margin')
    pg.evaluate("window.lg.input('press')")
    pg.wait_for_function("window.lg.ctl.screen === 'result'", timeout=8000)
    shot('08-result-margin')
    st, after3 = http('GET', W + '/api/state', headers=UH)
    liq1 = next(p for p in after3['positions'] if p['symbol'] == 'BTCUSDT')['liqDist']
    step('danger default "add margin": liq distance grows to ~10%', liq1 > liq0 and liq1 >= 0.095, suggestion=sug, before=round(liq0, 4), after=round(liq1, 4))
    pg.wait_for_function("window.lg.ctl.screen === 'glance'", timeout=8000)
    pg.evaluate('window.lg.tick()')
    time.sleep(0.3)
    shot('09-glance-after')
    br.close()

json.dump({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'worker': W, 'steps': log, 'failed': fails},
          open(f'{OUT}/log.json', 'w'), indent=1)
print('STEPS', len(log), 'FAILED', len(fails), fails)
sys.exit(1 if fails or not log else 0)
