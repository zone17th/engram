# P05-entryux Stage T Regression Specs Report (`worker-T-specs`)

**Branch:** `fix/entry-ux`  
**Worktree:** `D:/orca/workspaces/engram/p05-entryux`  
**References:** `docs/design/entry-editor.md`, `advisor-dec-370`, `advisor-dec-371`, `advisor-dec-373`

---

## 1. Files Modified & Created

| File | Action | Purpose |
|---|---|---|
| `apps/web/features/json-table/json-tree-grid.tsx` | Committed (`fix(web)` `bfd08ef`) | Enforced `[@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]` on `json-new-val-input-${containerPath}` in the saved JSON card `+ Add field` toolbar (`dec-370`). |
| `apps/web/e2e/vault-b-json-touch-targets.spec.ts` | Updated | Added `json-new-val-input-root` (`dec-370`) to the coarse-pointer 44×44 px 4-corner + center `elementFromPoint` probe list on the saved JSON card's add-field toolbar at `390×844` and `768×1024`. |
| `apps/web/e2e/content-a11y-item.spec.ts` | Updated | Verified the new KV composer (`new-json-entry-composer`) opens directly in Table mode (`new-json-tab-table` `aria-pressed="true"`, `json-table-host-new-json` visible, `json-new-key-input-root` focused, `new-json-save-btn` disabled) before switching to Raw JSON; added a coarse-pointer 44×44 px touch-target sweep on the open KV composer controls (`new-json-kv-composer-controls`). |
| `apps/web/e2e/content-entry-visual.spec.ts` | Created | New Stage T visual & behaviour regression spec covering 9 visual states across `390 / 768 / 1440 × light / dark` with byte-equal determinism assertions, item page no-horizontal-overflow at `390 / 768 / 1250 / 1440`, and E2E behaviour cases. |
| `scripts/sanitize-e2e-artifacts.mjs` | Updated | Added the 54 allowlisted `content-entry-<state>-<theme>-<width>.png` screenshot names (`9 states × 2 themes × 3 widths`) to `SAFE_SCREENSHOT_NAMES` so CI uploads them in `playwright-results-content-verify-true`. |
| `reports/entryux/worker-T-specs.md` | Created | This Stage T mapping report. |

*(Note: `apps/web/playwright.config.ts` and `.github/workflows/ci.yml` required no changes because `content-entry-visual.spec.ts` matches `/(^|[\\/])content-[a-z0-9-]+\.spec\.ts$/` in the `content` project and runs in the `e2e-content-verify-true` CI job alongside `content-itempage-visual.spec.ts`.)*

---

## 2. Spec → Cases Mapping

### A. Visual Captures & Byte-Equal Determinism (`apps/web/e2e/content-entry-visual.spec.ts`)
- **Suite:** `P05-entryux Stage T visual captures (390/768/1440 x light/dark, byte-equal determinism)`
- **Matrix:** Viewports `390×844`, `768×1024`, `1440×900` × Themes `light`, `dark` (54 total captures).
- **Determinism & Sanitization:**
  - Freezes CSS animations, transitions, and caret (`animation: none !important; transition: none !important; caret-color: transparent !important;`), hides any transient toast stack, blurs active focus, scrolls to top, and waits two `requestAnimationFrame` ticks after `document.fonts.ready`.
  - Masks `[data-testid="item-meta-summary"]` (timestamps) and all secret/body-bearing selectors (`[data-visual-mask]`, `entry-body`, `data-vault-secret`, `json-cell-btn-*`, `json-raw-textarea-*`, `import-json-*`).
  - Takes two consecutive screenshots per state and asserts `Buffer.compare(shot1, shot2) === 0` (no committed OS-dependent `toHaveScreenshot` baselines).
  - Writes each PNG to `testInfo.outputPath(...)` (staged by `scripts/sanitize-e2e-artifacts.mjs`) and attaches it via `testInfo.attach(...)`.
- **Captured States:**
  1. `locked-state` (`content-entry-locked-state-{light,dark}-{390,768,1440}.png`): Locked item page with `vault-locked-banner` and masked entry cards (`entry-body-locked`).
  2. `saved-json-card` (`content-entry-saved-json-card-{light,dark}-{390,768,1440}.png`): Unlocked saved JSON entry card (`JsonEntryCard` + `JsonTreeGrid`) in Table view.
  3. `empty-kv` (`content-entry-empty-kv-{light,dark}-{390,768,1440}.png`): Newly opened `NewJsonEntryComposer` in Table view with 1 blank placeholder row and disabled Save button.
  4. `filled-rows` (`content-entry-filled-rows-{light,dark}-{390,768,1440}.png`): KV editor with 3 filled rows (`service` string, `port` number via type chip, `tls` nested object with `mode: "strict"`).
  5. `raw-json` (`content-entry-raw-json-{light,dark}-{390,768,1440}.png`): `JSON gốc` (`Raw JSON`) tab with two-way synced JSON, `Format` button, and UTF-8 byte counter.
  6. `multiline-value` (`content-entry-multiline-value-{light,dark}-{390,768,1440}.png`): Auto-growing value `<textarea>` with a 5-line string value clamped at 3 lines and `kv-multiline-toggle-*` expand button visible.
  7. `validation-error` (`content-entry-validation-error-{light,dark}-{390,768,1440}.png`): Inline duplicate key error (`DUPLICATE_KEY` on `service`) + invalid RFC 8259 number lexeme (`INVALID_NUMBER` on `036`), `aria-invalid="true"`, and footer error count summary in `#new-json-save-reason`.
  8. `array-root` (`content-entry-array-root-{light,dark}-{390,768,1440}.png`): Root container switched to `Array` (`[]`) via `new-json-root-menu-btn` + inline confirmation prompt, showing `#` index badges and array items.
  9. `import-dialog` (`content-entry-import-dialog-{light,dark}-{390,768,1440}.png`): Import JSON modal dialog (`import-json-dialog`) with valid JSON source and `json-table-host-import-preview` treegrid.

### B. Item Page No-Horizontal-Overflow (`apps/web/e2e/content-entry-visual.spec.ts`)
- **Test:** `item page has no horizontal overflow at 390/768/1250/1440 with a 200-rune item name and long keys/values`
- **Assertions:** Seeds a 200-rune item name (`breadcrumb-item-name` & `item-name-input`), opens the KV editor with long unbroken key/value strings and a nested object container, and asserts `document.documentElement.scrollWidth <= window.innerWidth` at `390px`, `768px`, `1250px`, and `1440px`.

### C. E2E Behaviour Cases (`apps/web/e2e/content-entry-visual.spec.ts`)
1. **3 pairs (string, number via type chip, nested object) + `dec-370` saved card add-field:**
   - **Test:** `behaviour: add 3 pairs (string, number via type chip, nested object) -> save -> reopen -> exact JSON, plus dec-370 saved card add field with string and number values`
   - Adds `env: "staging"` (string), `retries: 5` (number via `kv-type-chip-*` -> `kv-pick-type-*-number`), and `db: { host: "db.internal" }` (nested object via `kv-pick-type-*-object`), saves, reloads + unlocks, and verifies exact JSON in the reopened card.
   - Exercises `dec-370` on the saved JSON card (`json-open-add-field-root`): adds string field `region: "ap-southeast-1"` and number field `timeout_ms: 1500` using `json-new-key-input-root`, `json-new-val-input-root`, and `json-new-type-select-root`, saves the card, reloads + unlocks, and verifies exact persisted JSON.
2. **Keyboard-only flow (`Tab`, `Shift+Tab`, `Enter`, `Shift+Enter`, `Alt+ArrowDown`, `Escape`, `Ctrl+S`):**
   - **Test:** `behaviour: keyboard-only flow (Tab, Enter, Shift+Enter, Alt+ArrowDown, Escape, Ctrl+S)`
   - Verifies native `Tab` / `Shift+Tab` order (`Key -> Value -> Type chip -> Row menu`), `Enter` from Key to Value, `Shift+Enter` inserting `\n` inside the string value `<textarea>`, `Enter` on last row's Value appending a new placeholder row, `Alt+ArrowDown` opening the Type menu (and `Escape` restoring focus to the Type chip, then `ArrowDown` + `Enter` selecting `Number`), `Escape` opening/closing the inline discard confirmation bar (`new-json-discard-confirm`), and `Ctrl+S` saving the entry.
3. **Paste `key: value` lines (URLs & times), paste PEM block into Value, and `Array -> Object` root conversion:**
   - **Test:** `behaviour: paste key: value lines (with URLs https://a.b:8080/x and times 12:30:45 split only at first ": "), paste PEM block into value -> save -> reopen byte-exact, and Array -> Object root conversion`
   - Pastes multi-line `endpoint: https://a.b:8080/x`, `window_start: 12:30:45`, `schedule: 08:00:00:backup:daily` and single-line `webhook: https://a.b:8080/x?at=12:30:45` into empty Key inputs and verifies splitting occurs only at the first `: ` so URLs and timestamps stay intact.
   - Pastes a multi-line PEM certificate block (containing `Subject: ...` and `NotBefore: 12:30:45 UTC` lines) into a Value `<textarea>` and verifies it is kept verbatim in that single row (`RFD-32`, `advisor-dec-373`), `Enter` still moves to the next row, and saving + reopening preserves the exact multi-line string.
   - Switches root `Object -> Array`, adds 2 array items (`alpha-node`, `beta-node`), switches `Array -> Object`, confirms the inline prompt (`2 items need key names`), verifies `EMPTY_KEY` validation disables Save until keys (`primary`, `secondary`) are entered, saves, and verifies the resulting JSON object.

### D. Existing E2E Specs Updated
- `apps/web/e2e/vault-b-json-touch-targets.spec.ts`: Probes `json-new-val-input-root` alongside `json-new-key-input-root`, `json-new-type-select-root`, `json-confirm-add-field-root`, and `json-cancel-add-field-root` at `390×844` and `768×1024`.
- `apps/web/e2e/content-a11y-item.spec.ts`: Verifies initial KV composer Table state + focus and sweeps coarse-pointer 44×44 px touch targets on `new-json-entry-composer`.
