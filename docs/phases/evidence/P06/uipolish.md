# P06 Task 6 — `uipolish` evidence

Branch `phase06/uipolish` (merged with `origin/phase06/beta` 178cfff). Heavy checks run on the Cursor cloud runner;
the targeted vitest files below were run locally from `apps/web` (`pnpm exec vitest run <file>`).

| Checkbox | Change | Tests |
|---|---|---|
| 1. tokens + `FU-T22-SEMCHIP-HOVER` | `.omni-sem-btn[aria-pressed='true']:hover` light/dark in `styles/tokens.css` | `tests/tokens.parity.test.ts` |
| 2. U18 states | `components/app-shell/offline-banner.tsx` (mounted in `RouteGuard`), session-expired midflow frame (`route-guard.tsx`), translated `app/app/error.tsx` + `app/app/not-found.tsx` + public `[locale]/not-found.tsx` and `[locale]/[...rest]` catch-all (F2), neutral `LockedBanner` (F-26), `#degr` inline notes already in `semantic-card.tsx` | `tests/states.test.tsx` (5 groups x en/vi) |
| 3. `/docs` links | header `?` (`nav.help`, locale-aware `/docs`), `semantic-card.tsx` link to `#rieng-tu` | `tests/app-shell.test.tsx`, `features/settings/search/semantic-card.test.tsx` (via `tests/settings-search.test.tsx`) |
| 4. ux-audit | F-04, F-05, F-06, F-08, F-12, F-13, F-14, F-17, F-20, F-21 (dialog part), F-22, F-23, F-26, F-33, F-34, F-35, F-37, F-41 (UI part) | `route-guard`, `app-shell`, `auth-forms`, `account-panel-oauth`, `vault-passkey-dialog`, `vault-unlock`, `omnibox`, `app-home-page`, `import-dialog` |
| 5. follow-ups | `FU-T26-390-OVERFLOW` (CSS), `FU-T22-429-STICKY` (CSS), `A11Y-UNDO-FOCUS-FLICKER`; `A11Y-SAVING-LIVE` was already announced via `onAnnounce('saving')` | `tokens.parity`, `item-page` |
| 6. `dialog.tsx` | `returnFocusRef`, `initialFocusRef`, `dismissible` | `tests/dialog.test.tsx` |

Not done / partial: `FU-ENTRYUX-N1` (saved add-field select styling), `N3` (edit header wrap at 390), `N5` (triple
over-cap message) are not individually changed; `N2`/`N4` are covered by the phone-width JSON table CSS. F-05 targets
that belong to `docsprivacy` (`LocaleSwitch`, landing) and Settings tab-steps / "Mark read" are untouched.

Out-of-row files (reason): `app/app/error.tsx`, `app/app/not-found.tsx`, `app/(marketing)/[locale]/{not-found.tsx,[...rest]/page.tsx}`
(F2 / U18 `#err-server-500` / `#err-not-found`, contract-assigned); `components/ui/undo-toast.tsx` (call order only, cause of
`A11Y-UNDO-FOCUS-FLICKER`); `app/app/page.tsx` example list (F-34).
