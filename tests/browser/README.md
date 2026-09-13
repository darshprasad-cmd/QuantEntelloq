# App interface smoke checks

Serve the repository with a local static server, for example:

```powershell
python -m http.server 8774
```

Run the smoke checks in a second terminal with Node and a separately installed
Playwright package and Chromium browser:

```powershell
$env:QUANT_BASE_URL = 'http://127.0.0.1:8774'
# Optional when Playwright is available outside the normal Node module path:
$env:PLAYWRIGHT_MODULE = 'C:/path/to/node_modules/playwright'
node tests/browser/app-ui-smoke.cjs
```

The check covers header touch targets, every desktop navigation destination in
the mobile menu, Learn access, keyboard focus containment and restoration,
Escape, scroll preservation, viewport resize cleanup, disclaimer dock offsets,
desktop More navigation, historical crisis keyboard selection, immediate mobile
search availability after resize and page errors at 320, 390, 820 and 1440 pixels.

The fixture is an isolated local browser profile with a synthetic user. It only
accepts localhost URLs and blocks API and external requests. It does not test
real authentication, provider availability, live prices, AI responses, billing,
or trade execution. No application dependencies are added by this test.
