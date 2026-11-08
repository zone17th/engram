# P06 Task 6 — `uipolish` evidence

Branch `phase06/uipolish` (merged with `origin/phase06/beta` 178cfff). Heavy checks run on the Cursor cloud runner;
the targeted vitest files below were run locally from `apps/web` (`pnpm exec vitest run <file>`).

| Checkbox | Change | Tests |
|---|---|---|
| 1. tokens + `FU-T22-SEMCHIP-HOVER` | `.omni-sem-btn[aria-pressed='true']:hover` light/dark in `styles/tokens.css` | `tests/tokens.parity.test.ts` |
| 2. U18 states | `components/app-shell/offline-banner.tsx` (mounted in `RouteGuard`), session-expired midflow frame (`route-guard.tsx`), translated `app/app/error.tsx` + `app/app/not-found.tsx` + public `[locale]/not-found.tsx` (r5 R2-M1: `states.pageNotFoundBody` under the title, link text `states.backHome`) and `[locale]/[...rest]` catch-all (F2), neutral `LockedBanner` (F-26), `#degr` inline notes already in `semantic-card.tsx` | `tests/states.test.tsx` (5 groups x en/vi) |
| 3. `/docs` links | header `?` (`nav.help`, locale-aware `/docs`), `semantic-card.tsx` link to `#rieng-tu` | `tests/app-shell.test.tsx`, `features/settings/search/semantic-card.test.tsx` (via `tests/settings-search.test.tsx`) |
| 4. ux-audit | F-04, F-05, F-06, F-08, F-12, F-13, F-14, F-17, F-20, F-21 (dialog part), F-22, F-23, F-26, F-33, F-34, F-35, F-37, F-41 (UI part) | `route-guard`, `app-shell`, `auth-forms`, `account-panel-oauth`, `vault-passkey-dialog`, `vault-unlock`, `omnibox`, `app-home-page`, `import-dialog` |
| 5. follow-ups | `FU-T26-390-OVERFLOW` (CSS), `FU-T22-429-STICKY` (CSS), `A11Y-UNDO-FOCUS-FLICKER`; `A11Y-SAVING-LIVE` was already announced via `onAnnounce('saving')` | `tokens.parity`, `item-page` |
| 6. `dialog.tsx` | `returnFocusRef`, `initialFocusRef`, `dismissible` | `tests/dialog.test.tsx` |

Follow-ups `FU-ENTRYUX-N1`, `N3`, `N5` (branch `phase06/uipolish-n135`, r4); `N2`/`N4` are covered by the phone-width JSON table CSS above.
Real 390 px measurement and light/dark screenshots belong to tester_visual; jsdom asserts classes and CSS text only.

| Follow-up | Change | Tests |
|---|---|---|
| `FU-ENTRYUX-N1` saved add-field select styling | `json-tree-grid.tsx`: type select gets `kv-type-chip json-add-field-type` + `data-kv-type` (colour family via `addFieldChipKind`), form gets `json-add-field-form`; `tokens.css`: chip-width select (r5 R2-L1: the duplicated `.json-add-field-type[data-kv-type]` colour rules are removed; `.kv-type-chip[data-kv-type]` colours it), phone grid (key / value full rows, type | Add | Cancel on one row) | `json-entry-card.test.tsx` (add-field case), `tokens.parity.test.ts` |
| `FU-ENTRYUX-N3` edit header wrap at 390 | `json-entry-card.tsx`: byte counter is `max-sm:hidden` in the header and repeated in the Save/Cancel footer bar (`sm:hidden`, testid `entry-byte-counter-footer-<id>`); drag handle `max-[420px]:hidden` in edit state; Copy stays in the header and in the `⋯` menu | `json-entry-card.test.tsx` |
| `FU-ENTRYUX-N5` triple over-cap message | `import-dialog.tsx`: the over-cap status line under the textarea is empty (alert box + red source counter keep the limit); `importStatusOverCap` key left unused (messages are not this lane's) | `import-dialog.test.tsx` |

Targeted vitest (from `apps/web`, exit 0): `npx vitest run tests/tokens.parity.test.ts features/json-table/json-entry-card.test.tsx features/json-table/import-dialog.test.tsx` (94 pass); `npx vitest run tests/json-table.test.tsx features/json-table/json-cell-draft-retention.test.tsx` (11 pass); `npx eslint` on the 6 changed ts/tsx files (0 errors).

Round r5 (P06-T6, worker-3; branch `phase06/uipolish-n135`): R2-M1 public 404 wired to the landed contract keys; R2-L1 dedupe; `e2e/transport.spec.ts:272` text assertion updated to the branded copy (advisor-dec-046). `tests/states.test.tsx` asserts body + home link name + href in en and vi and that no link is named `engram`. Targeted vitest (from `apps/web`, exit 0): `npx vitest run tests/states.test.tsx tests/tokens.parity.test.ts features/json-table/json-entry-card.test.tsx` (3 files, 101 pass); `npx eslint` on the 3 changed ts/tsx files (0 errors). The `transport.spec.ts` edit is not run locally (no playwright on the host); it belongs to the cloud e2e round.

Still not individually changed: F-05 targets that belong to `docsprivacy` (`LocaleSwitch`, landing) and Settings tab-steps / "Mark read".

Out-of-row files (reason): `app/app/error.tsx`, `app/app/not-found.tsx`, `app/(marketing)/[locale]/{not-found.tsx,[...rest]/page.tsx}`
(F2 / U18 `#err-server-500` / `#err-not-found`, contract-assigned); `components/ui/undo-toast.tsx` (call order only, cause of
`A11Y-UNDO-FOCUS-FLICKER`); `app/app/page.tsx` example list (F-34); `e2e/transport.spec.ts` (line 272, 404 text assertion only, advisor-dec-046; CSP / one-header / 0-violation checks untouched).
