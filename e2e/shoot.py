# Screenshot every fixture screen of the preview harness at 576x288, deviceScaleFactor 1.
# Usage: python -u e2e/shoot.py <base_url> <out_dir>
import sys, os
from playwright.sync_api import sync_playwright

base, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME') or None, headless=True,
                          args=['--no-sandbox', '--disable-gpu'])
    pg = b.new_page(viewport={'width': 576, 'height': 288}, device_scale_factor=1)
    pg.on('pageerror', lambda e: print('PAGEERROR', e, flush=True))
    pg.on('console', lambda m: print('CONSOLE', m.type, m.text[:200], flush=True) if m.type in ('error', 'warning') else None)
    pg.goto(f'{base}/preview.html?fixture=glance-calm&chrome=0')
    pg.wait_for_function('document.body.dataset.ready', timeout=10000)
    names = pg.evaluate('window.fixtureNames')
    assert names, 'no fixtures'
    bad = []
    for n in names:
        pg.goto(f'{base}/preview.html?fixture={n}&chrome=0')
        pg.wait_for_function('document.body.dataset.ready', timeout=10000)
        ready = pg.evaluate('document.body.dataset.ready')
        if ready != '1':
            bad.append((n, ready))
        pg.screenshot(path=f'{out}/{n}.png', clip={'x': 0, 'y': 0, 'width': 576, 'height': 288})
        print('shot', n, ready, flush=True)
    b.close()
    if bad:
        print('INVALID', bad); sys.exit(1)
    print('screens', len(names))
