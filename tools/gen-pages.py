"""Writes the <head> of every page (CSP, icons, manifest, fonts). Run: python3 tools/gen-pages.py"""
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUPA = "https://ipcodsedkvxldqyxpnhx.supabase.co"
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; worker-src 'self'; "
       f"img-src 'self' data: blob: {SUPA}; connect-src 'self' {SUPA} wss://ipcodsedkvxldqyxpnhx.supabase.co; "
       "media-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'")
PAGES = {  # file: (title, script, description or None, noindex)
    'index': ('XGo+ — More Savings. More Comfort.', 'home', 'Discounts for XGo+ members at restaurants, cafés, doctors, salons, car washes and more.', False),
    'offers': ('Offers · XGo+', 'offers', 'All XGo+ partner offers.', False),
    'search': ('Search · XGo+', 'search', None, True),
    'provider': ('Partner · XGo+', 'provider', None, False),
    'about': ('About · XGo+', 'about', 'About XGo+ and how to contact us.', False),
    'login': ('Log in · XGo+', 'login', None, False),
    'signup': ('Sign up · XGo+', 'signup', None, False),
    'membership': ('Membership · XGo+', 'membership', None, False),
    'account': ('Account · XGo+', 'account', None, True),
    'history': ('History · XGo+', 'history', None, True),
    'report': ('Report · XGo+', 'report', None, True),
    'partner': ('Partner portal · XGo+', 'partner', None, True),
    'admin': ('Admin · XGo+', 'admin', None, True),
    '404': ('Not found · XGo+', 'notfound', None, True),
    'v': ('Verify member · XGo+', 'verify', None, True),
}
for name, (title, script, desc, noindex) in PAGES.items():
    base = '\n  <base href="/">' if name == '404' else ''
    extra = ''
    if noindex: extra += '\n  <meta name="robots" content="noindex">'
    if desc: extra += f'\n  <meta name="description" content="{desc}">'
    html = f'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">{base}
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta http-equiv="Content-Security-Policy" content="{CSP}">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta name="theme-color" content="#2a1670">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="XGo+">{extra}
  <title>{title}</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
  <link rel="preload" href="/fonts/poppins-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/css/style.css">
  <script type="module" src="/js/pages/{script}.js"></script>
</head>
<body>
  <main id="app"><div class="spinner" aria-label="Loading"></div></main>
</body>
</html>
'''
    open(os.path.join(ROOT, f'{name}.html'), 'w').write(html)
print('pages written:', len(PAGES))
