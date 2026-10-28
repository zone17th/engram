# Visual regression references

The `win32` references capture the current public landing implementation on
2026-09-16 with Playwright 1.56.0 Chromium, at 390, 768, and 1440 pixels, in both
locales and themes. The demo uses the public `ghi` search fixture and reduced
motion; no account, token, password, or private content is captured.

These references were inspected against `mockups/landing.html` for layout,
typography, contrast, and responsive clipping. They preserve the current P01
demo and copy. The mockup has a richer search demonstration and different CTA
copy; pixel equivalence to that mockup is not claimed.

Run the current-platform comparison against an already running production web:

```powershell
$env:BASE_URL = 'http://127.0.0.1:13001'
$env:VISUAL_COMPARE = '1'
pnpm --filter @engram/web exec playwright test --config=playwright.visual.config.ts --grep 'visual landing'
```

Capture mode (without `VISUAL_COMPARE`) writes separate production/mockup PNGs
and a manifest into `test-results/acceptance-visual`. Inspect changes before
replacing references. Platform-specific paths keep Windows references separate
from the pinned Linux Playwright image required by final P01 acceptance.
Authenticated P02 captures require `E2E_STACK=1` and a healthy real API; they have
not been approved as baselines yet. See `docs/phases/evidence/P01.md` and `P02.md`.
