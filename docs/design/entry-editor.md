# JSON / Key-Value Entry Editor — Design Note (P05-entryux, r3)

**Ruling:** `advisor-dec-371` + `advisor-dec-370` (owner feedback: *"very hard to add a set of entry values; make UI nice, UX easy"*).  
**Mockup reference:** `mockups/item.html` (`#card-json-new`), `mockups/mock.js` (`SAK.initKvEntryEditor`), `mockups/tokens.css` (`.kv-*`).  
**Lossless invariant:** P04 lossless JSON rules (`docs/SPEC.md` §3.7, §7.4 line 1303, ADR 0005) remain unchanged. No silent type auto-coercion, key trimming, or value substitution ever occurs.

---

## 1. Overview, Canonical Source & Entry States

Clicking **`+ JSON / bảng`** (`#btn-add-json`) opens `#card-json-new` directly in the **Bảng** (Table / Key-Value) view with **1 placeholder row** (`key = ""`, `value = ""`, `type = "string"`, `placeholder = true`) and places focus inside the first **Key** input.

- **No initialization chooser step:** The previous `Khởi tạo: {} · Đối tượng rỗng / [] · Mảng rỗng` bar is removed. Root defaults to **Object** (`{}`). Switching the root container to **Mảng** (`[]`) is a secondary choice in the header dropdown menu (`[data-kv-root-menu-btn]`).
- **Container & root switch protection (`RFD-13`, `RFD-20`, `RFD-23`):**
  - Switching `Object → Array` (at root or on a nested row) when non-empty keys exist reveals an inline confirmation banner (`{N} trường sẽ mất tên khi chuyển sang Mảng · {N} keys will be dropped when switching to Array`) with **Chuyển sang Mảng** / **Giữ Object** and toast **Hoàn tác** (`Undo`).
  - Switching `Array → Object` (at root or on a nested row) when `>= 1` committed items exist reveals an inline confirmation banner (`{N} phần tử cần đặt tên trường khi chuyển sang Object · {N} items need key names`) with **Chuyển & đặt tên** / **Giữ Mảng**. On any container-kind change, `fromRaw` and `rawKeyLiteral` are cleared on direct children so `EMPTY_KEY` and `DUPLICATE_KEY` rules apply immediately—never silently saving `{"":1,"":2}`.
  - Switching a container row (`Object` or `Array`) with `>= 1` committed child to a scalar type (`string`, `number`, `boolean`, `null`) reveals an inline confirmation banner (`{N} trường con/phần tử con sẽ bị xoá khi đổi sang kiểu đơn`) with **Đổi kiểu & xoá con** / **Huỷ** and toast **Hoàn tác** (`RFD-23`).
- **Text-canonical payload (`RFD-2`):** Matching `apps/web/features/json-table/json-new-entry-composer.tsx` (`tableSource`), whenever the last edit occurred in **JSON gốc** (`Raw JSON`), the saved payload is the **verbatim raw text** (`canonicalRawText`), preserving custom whitespace, `\uXXXX` escape sequences, and duplicate keys. Re-serialization from rows (or source splicing in `json-tree-grid`) occurs only when a row is mutated in the **Bảng** view, and unedited raw properties retain their original `rawKeyLiteral` / `rawValueLiteral`.
- **Empty containers & placeholders (`RFD-1`, `RFD-3`, `RFD-21`):**
  - Empty containers parsed from JSON (`{}` or `[]`) have **zero rows** (`children = []`) and render an explicit empty affordance (`Object rỗng {} (0 trường)` / `Mảng rỗng [] (0 phần tử)`) with a **`+ dòng`** / **`+ phần tử`** button, so `[""]` and `{"":""}` are never confused with empty containers.
  - In **Object** containers, any table-authored (`!fromRaw`) completely blank string row (`type === "string"`, `key === ""`, `value === ""`) at **any position** (middle or trailing) is treated as an un-committed placeholder (`isEffectivePlaceholderRow`): it never triggers `EMPTY_KEY` validation errors and is omitted on serialize (`RFD-21`). Raw-origin `{"":""}` (`fromRaw: true`) is preserved verbatim.
  - In **Array** containers, only the trailing blank un-authored row is skipped as a placeholder; a cleared middle array item stays as `""` (with placeholder hint `Giá trị mục #N (trống = "")`) so item indices do not shift silently (`RFD-21`).
- **Row anatomy & fixed column alignment (`RFD-9`):**
  - Desktop/tablet (`>= 640 px`) uses a 4-track grid matching `.kv-col-head`:
    - Object rows: `grid-template-columns: minmax(140px, 34%) minmax(0, 1fr) 9.5rem 44px` (`[Key] [Value] [Type chip] [⋯]`).
    - Array rows: `grid-template-columns: 44px minmax(0, 1fr) 9.5rem 44px` (`[#] [Value] [Type chip] [⋯]`).
  - The **`Số?`** suggestion chip is positioned as an inline end adornment inside `.kv-val-adorn-wrap` (`padding-right: 60px`), so every row's value column, type chip column, and `⋯` menu column align vertically regardless of row type or suggestion state.
  - Mobile (`<= 639 px`, `390 px` viewport, `RFD-17`, `RFD-30`): Compact 2-line layout per row (`Key` full width on line 1; `[Value (1fr)] [Type chip (auto)] [⋯ (44px)]` on line 2), with a `44px` action track so coarse-pointer `44×44 px` menu triggers never overflow. Container summary pills switch to compact count format (`Object (3)` / `Mảng (2)`) below `640 px` while keeping the full bilingual description in `aria-label`.

| State | Description | Save button (`Ctrl+S`) |
|---|---|---|
| **Empty editor** | Newly opened with 1 placeholder row (`placeholder = true`). No error border is shown. | `disabled` with muted status: *"Nhập ít nhất một trường để lưu entry."* |
| **Filled rows (valid)** | 1+ committed rows with valid keys and values (plus any trailing blank placeholder row). | `enabled` |
| **Inline validation error** | Any non-placeholder row has an empty key (when value is filled or non-default type), table-authored duplicate key, or invalid RFC 8259 number lexeme. | `disabled` with visible `.kv-save-reason` summarizing error count and first error (`Chưa thể lưu (4 lỗi — ...)`). |
| **Raw JSON tab (`JSON gốc`)** | Two-way synced `<textarea>` with **Định dạng** (`Format`) and live UTF-8 byte counter. Switching back to **Bảng** is blocked with an inline alert *only* if the user edited Raw JSON (`rawEditedSinceSwitch = true`) and introduced syntax errors, or if Raw has a scalar root (`RFD-1`, `RFD-22`). | `disabled` while syntax error or `> 256 KiB` (`262,144 B`). |
| **Dirty cancel prompt** | Pressing `Esc` or clicking **Huỷ** when dirty shows an inline confirmation bar (`Tiếp tục sửa` / `Bỏ thay đổi`), never a modal. | Unchanged until user chooses. |

---

## 2. Lossless Round-Trip & Explicit Types (`RFD-1`, `RFD-8`)

Every new row defaults to **Văn bản** (`string`). Values are **never** silently coerced to numbers, booleans, or `null`.

- **Lossless string & key handling (`RFD-1`):**
  - **Keys are never trimmed:** `r.key` is preserved verbatim (`{" a": 1}` stays `{" a": 1}`). If a key has leading or trailing spaces, a non-blocking warning note is shown beneath the key input (*"Khoá có khoảng trắng đầu/cuối (được giữ nguyên)"*).
  - **Multiline strings (`\n`):** When a string value contains LF (`\n`), the value cell renders an auto-sized `<textarea class="kv-input">` instead of `<input type="text">`, so editing the cell never strips line breaks.
  - **Unsafe string characters (`\r` or lone surrogates, `SPEC:1303`):** Cells whose string value or key contains `\r` or a lone UTF-16 surrogate render as read-only in the **Bảng** view (`.kv-readonly-cell`, `role="textbox"`, `aria-readonly="true"`) with a badge explaining they must be edited in **JSON gốc**.
  - **Scalar root (`5`, `"abc"`, `true`, `null`):** Raw JSON saves scalar roots verbatim. Attempting to switch from **JSON gốc** to **Bảng** when the root is a scalar is blocked with an inline explanation (*"Giá trị gốc là kiểu đơn... Chế độ Bảng chỉ áp dụng cho Object {} hoặc Mảng []"*)—scalars are never wrapped into `{"value": ...}`.
- **Invalid numbers are never substituted (`RFD-8`):**
  - If a `number` row has an invalid lexeme (e.g. `036`) or is empty, `serializeNodeValue` emits the user's raw text verbatim (never `'0'`). Viewing **JSON gốc** shows the exact syntax error, and switching back to **Bảng** without editing Raw (`!rawEditedSinceSwitch`) is always allowed so a table error never traps the user in Raw (`RFD-22`).
- **Type chip menu (`[data-kv-act="toggle-type-menu"]`):** Explicitly switches row type between:
  1. `Văn bản` / `Text` (`string`) — default (switching from `string` to `string` when value is `"null"` preserves `"null"`; `"null"` is only cleared when switching *from* type `null`, `RFD-14`).
  2. `Số` / `Number` (`number`) — verbatim RFC 8259 lexeme preserved (`9007199254740993`, `-0`, `1.50`).
  3. `true / false` / `Boolean` (`boolean`) — renders inline `[true | false]` segmented toggle.
  4. `null` (`null`) — renders read-only `null` pill (`role="note"` with `.sr-only` context label).
  5. `Object` (`object`) — expands inline `.kv-nest` group with indent and its own `+ dòng` button.
  6. `Mảng` / `Array` (`array`) — expands inline `.kv-nest` list with `#` index badges and its own `+ dòng` button.
  - *Note on i18n (`RFD-14`):* `Object` is intentionally kept as the technical term `Object` in both Vietnamese and English type chips (`kv.type.object = "Object"`), matching developer/vault terminology across SPEC §7.4, whereas container descriptions use `Bảng khoá–giá trị (Object)`.

---

## 3. Keyboard Map, Menu Pattern & Paste Behaviour (`RFD-4`, `RFD-5`, `RFD-6`, `RFD-7`, `RFD-11`, `RFD-16`, `RFD-19`, `RFD-25`..`RFD-28`)

| Key / Gesture | Target | Action |
|---|---|---|
| `Enter` | Key input | Moves focus to Value input (or Type chip if container/null) on the same row. On an untouched trailing blank placeholder row inside a nested container, `Enter` outdents to a new row after the parent (`RFD-28`). |
| `Tab` / `Shift+Tab` | Any control | **Native focus traversal (`RFD-6`):** Key → Value → `Số?` (if shown) → Type chip → Row menu `⋯` → next row. Never hijacked. |
| `Alt+↓` (`Alt+ArrowDown`) | Key or Value input | Opens the row's **Type menu** directly and focuses the checked `menuitemradio` (`RFD-6`). |
| `Enter` | Value input (non-last row) | Moves focus to the next row's Key input (or Value input in Array mode). (`Shift+Enter` inserts newline in multiline `<textarea>`). |
| `Enter` | Value input (last row) | When the row has content, appends a new placeholder row (`placeholder: true`) and focuses its first input (`RFD-3`). When the trailing placeholder row is still completely blank (`RFD-28`), `Enter` does not pile up extra blank rows; inside a nested container it outdents by removing the trailing blank row and focusing a new sibling row after the parent container. |
| `Backspace` | Empty Key or empty Value | When the entire row is a blank string row (`isRowCompletelyBlank(row, parentKind)`: `type === "string"`, `key === ""`, `value === ""`) and the container has `> 1` row, removes the row and focuses the previous row (`RFD-11`). Never deletes `object`, `array`, `boolean`, or `null` rows. |
| `ArrowDown` / `ArrowUp` / `Home` / `End` / Typeahead | Type menu, Row menu `⋯`, Root menu | **Menu keyboard pattern (`RFD-7`, `RFD-26`):** Opening any menu moves focus to the checked/first item; `ArrowDown`/`ArrowUp` rove cyclically; `Home`/`End` jump to first/last; character keys jump by prefix; `Tab` closes the menu and focuses its trigger synchronously so native `Tab` continues to the next control; `Esc` closes the menu and restores focus to its trigger button. |
| `Paste` (`Ctrl/⌘+V`) | Key input or empty Value input | **Safe paste with Undo (`RFD-4`, `RFD-16`, `RFD-19`, `RFD-27`):**<br>• **Value inputs (`RFD-19`):** Single-line pastes (URLs `https://...`, base64 `dGVzdA==`, times `10:30`, connection strings) are **never** intercepted—they paste normally into the value field. Value inputs only intercept multi-line pastes (`>= 2` non-empty lines) where every line matches `key: value` / `key=value` (in Object) or plain lines (in Array).<br>• **Key inputs (`RFD-19`):** Intercepts valid JSON objects/arrays, multi-line `key: value` / `key=value` pairs (`>= 2` lines), or a single line matching explicit `key: value` (colon + space, non-URL scheme) / `key=value`.<br>• **JSON object/array:** Replaces the whole editor *only* when blank; inserts into current container if shapes match; otherwise opens an inline prompt (`Thay giá trị dòng này · Replace this row's value` / `Thay toàn bộ · Replace all` / `Huỷ · Cancel`). Replacing a row's value keeps its existing key verbatim (never inventing `"data"`, `RFD-27`).<br>• Every intercepted paste shows a toast with **Hoàn tác** (`Undo`). |
| `Ctrl+S` / `⌘+S` | Anywhere in card | Validates and triggers Save (when valid). |
| `Esc` | Menu or inline prompt open | Closes open Type menu, Row menu `⋯`, Root menu, or inline prompt banner and restores focus to the originating control (`RFD-5`, `RFD-25`). |
| `Esc` | Input / Card | Cancels immediately if clean; reveals inline discard confirmation (`[data-kv-discard-confirm]`) if dirty (`RFD-5`). |

---

## 4. Inline Validation & Accessibility (`RFD-10`, `RFD-12`, `RFD-24`, `RFD-25`, `RFD-29`)

- **No per-row `role="alert"` or per-keystroke footer `role="status"` spam (`RFD-10`, `RFD-24`):**
  - Inline error paragraphs (`<p class="kv-row-err" id="kv-err-...">`) do **not** carry `role="alert"`. Instead, offending inputs set `aria-invalid="true"` and `aria-describedby="kv-err-..."`.
  - `#new-json-save-reason` does **not** carry `role="status"` (it is already linked to `#new-json-save-btn` via `aria-describedby`), and `syncFooterAndRaw` only mutates its DOM when the reason text or class actually changes (`RFD-24`).
  - Typing in an input updates validation state and DOM attributes in place (`refreshValidationInPlace`) without replacing the `<input>` element, and also updates the row group `aria-label`, the leading/trailing key-space warning (`#kv-warn-key-...` wired into `aria-describedby`), and the row-scoped `Số?` button `aria-label` in place (`RFD-29`).
  - A single card-level polite live region (`[data-kv-live-region]`, `aria-live="polite"`) announces error state changes debounced (`300 ms`) only when the active error signature (`rowId:code`) changes.
  - When an inline confirmation prompt (`[data-kv-inline-prompt]`) opens, its message carries `role="alert"`, focus moves to the first action button, and dismissing (`Esc` or **Huỷ**) restores focus to the originating control (`RFD-25`).
- **Validation rules:**
  1. `EMPTY_KEY`: Key is `""` on a non-placeholder, table-authored row (`!fromRaw`) that has a non-empty value or non-default type, or on a row whose parent was switched from Array to Object (`RFD-20`). Table-authored completely blank string rows (`key === ""`, `value === ""`, `type === "string"`) at any position in an Object are treated as placeholders and skipped on serialize (`RFD-21`). Raw-origin `{"":""}` (`fromRaw: true`) is valid per RFC 8259 (`RFD-1`).
  2. `DUPLICATE_KEY`: Two or more rows in the same Object share the exact key `r.key` **and** the row was authored/edited in the table (`!r.fromRaw`). Raw-origin duplicate keys (`{"a":1,"a":2}`) do **not** block Save; they render occurrence badges (`⁽²⁾`, `.kv-occ-badge`) matching `json-tree-grid.tsx` (`RFD-2`).
  3. `INVALID_NUMBER`: Row type is `number` and the value is empty or violates RFC 8259 number grammar (e.g. `036`, `12.`).
  4. `RAW_SYNTAX_ERROR` / `OVER_CAP`: Raw JSON fails `parseJsonStrict` or UTF-8 byte length exceeds `262,144 B` (`256 KiB`).
- **Save button reason summary (`RFD-10`, `RFD-24`):** `#new-json-save-btn` references `#new-json-save-reason` via `aria-describedby`, which summarizes total errors and the first message (`Chưa thể lưu (4 lỗi — Trường “ssid” bị trùng trong cùng object.) · Cannot save (4 errors — ...)`).
- **Hierarchical accessible names (`RFD-12`, `RFD-29`):**
  - Every `li.kv-row` has `role="group"` with a contextual `aria-label` including its parent path (e.g. `guest › Dòng 1: ssid · guest › Row 1: ssid`), updated live on key input.
  - Nested inputs include the full ancestor path in their `aria-label` (e.g. `network › firewall_rules_v6_production › Trường hàng 1 · Key row 1`).
  - Nested `.kv-nest` containers carry bilingual `aria-label` (`Object con của guest · Nested object for guest`).
  - Orphan `<label for="kv-val-...">` elements on Boolean, `null`, and Container rows are removed; `.kv-null-pill` uses an `.sr-only` text span for screen readers.
---

## 5. Copy & i18n Key Table (`vi` / `en`) (`RFD-14`)

| i18n Key | Vietnamese (`vi`) | English (`en`) |
|---|---|---|
| `kv.cardTitle` | `Entry JSON mới` | `New JSON entry` |
| `kv.mode.table` / `kv.mode.raw` | `Bảng` / `JSON gốc` | `Table` / `Raw JSON` |
| `kv.root.object` / `kv.root.array` | `Gốc: Object` / `Gốc: Mảng` | `Root: Object` / `Root: Array` |
| `kv.rootMenu.object` / `kv.rootMenu.array` | `Bảng khoá–giá trị (Object)` / `Mảng danh sách` | `Key-value object` / `Array list` |
| `kv.col.key` / `kv.col.value` / `kv.col.type` | `Trường` · `Giá trị` · `Kiểu` | `Key` · `Value` · `Type` |
| `kv.placeholder.key` | `Tên trường (vd: ssid)` | `Key` |
| `kv.placeholder.value` / `kv.placeholder.number` | `Giá trị` / `Giá trị số (vd: 36)` | `Value` / `Number value` |
| `kv.type.string` / `kv.type.number` / `kv.type.boolean` | `Văn bản` · `Số` · `true / false` | `Text` · `Number` · `Boolean` |
| `kv.type.null` / `kv.type.object` / `kv.type.array` | `null` · `Object` · `Mảng` | `null` · `Object` · `Array` |
| `kv.suggestNumber` | `Số?` | `Number?` |
| `kv.addRow.rootObject` / `kv.addRow.rootArray` | `+ Thêm dòng` / `+ Thêm phần tử` | `+ Add field` / `+ Add item` |
| `kv.addRow.nestedObject` / `kv.addRow.nestedArray` | `+ dòng` / `+ phần tử` | `+ Add field` / `+ Add item` |
| `kv.emptyContainer.object` / `kv.emptyContainer.array` | `Object rỗng {} (0 trường)` / `Mảng rỗng [] (0 phần tử)` | `Empty object {} (0 fields)` / `Empty array [] (0 items)` |
| `kv.rowMenu.insertBelow` | `Chèn dòng bên dưới` | `Insert row below` |
| `kv.rowMenu.moveUp` / `kv.rowMenu.moveDown` / `kv.rowMenu.delete` | `Chuyển lên` · `Chuyển xuống` · `Xoá dòng` | `Move up` · `Move down` · `Delete row` |
| `kv.pasteTip.object` | `Mẹo: dán nhiều dòng key: value hoặc JSON · Alt+↓ đổi kiểu` | `Tip: paste key: value lines or JSON · Alt+↓ change type` |
| `kv.pasteTip.array` | `Mẹo: dán mỗi dòng một giá trị hoặc mảng JSON` | `Tip: paste one value per line or JSON array` |
| `kv.err.emptyKey` | `Nhập tên trường hoặc xoá dòng trống.` | `Enter a field name or remove the empty row.` |
| `kv.err.duplicateKey` | `Trường “{key}” bị trùng trong cùng object.` | `Duplicate key “{key}” in the same object.` |
| `kv.err.invalidNumber` | `Số không đúng định dạng JSON (ví dụ: 36, -1.5, 1e4; không có số 0 đứng đầu).` | `Invalid JSON number (e.g. 36, -1.5, 1e4; no leading zeros).` |
| `kv.saveDisabled.blankObject` / `kv.saveDisabled.blankArray` | `Nhập ít nhất một trường để lưu entry.` / `Nhập ít nhất một giá trị để lưu entry.` | `Enter at least one field to save.` / `Enter at least one item value to save.` |
| `kv.saveDisabled.errorSummary` | `Chưa thể lưu ({count} lỗi — {reason})` | `Cannot save ({count} errors — {reason})` |
| `kv.footer.cancel` / `kv.footer.save` | `Huỷ` `<kbd>Esc</kbd>` · `Lưu` `<kbd>Ctrl+S</kbd>` | `Cancel` `<kbd>Esc</kbd>` · `Save` `<kbd>Ctrl+S</kbd>` |

---

## 6. Review r1 Findings (`RFD-1` .. `RFD-18`) Resolution Summary

All 18 findings from `review-fe-design-r1.md` (4 HIGH, 6 MEDIUM, 8 LOW) are resolved in r2 (0 skipped):

| ID | Severity | Finding | Resolution in r2 |
|---|---|---|---|
| **RFD-1** | HIGH | Table round trip changes/drops data (`\n`, `[""]`, `{"":""}`, `{" a":1}`, scalar root). | Empty containers render 0 rows + empty affordance; placeholders use explicit `placeholder: true`; keys never trimmed; `\n` uses `<textarea>`; `\r`/surrogates render read-only cell; scalar roots blocked from Table switch with explanation, never wrapped. |
| **RFD-2** | HIGH | Raw-authored JSON re-serialized instead of saved verbatim; raw duplicate keys block Save. | `canonicalRawText` saved verbatim when last edited in Raw; unedited raw literals preserved; `DUPLICATE_KEY` only flags table-authored rows; raw duplicates render `⁽²⁾` occurrence badges and allow Save. |
| **RFD-3** | HIGH | Enter on last value creates a row that immediately errors and disables Save. | Trailing blank string rows (`placeholder: true` or `isEffectivePlaceholderRow`) never trigger `EMPTY_KEY` and are skipped on serialize. |
| **RFD-4** | HIGH | Pasting JSON object replaces whole editor from any field with no undo. | Whole editor replaced only when blank; otherwise inserts into caret's container if shapes match, or prompts inline (`Lồng vào dòng này` / `Thay toàn bộ` / `Huỷ`). All pastes include toast **Hoàn tác** (`Undo`). |
| **RFD-5** | MEDIUM | `Esc` never cancels (`e.key === 'escape'` case bug); root menu lacks `Esc`. | Fixed to `k === 'escape'`; `Esc` closes root/type/row menus and restores trigger focus, or opens discard confirm when dirty. |
| **RFD-6** | MEDIUM | `Tab` on value skips type chip and row menu. | Removed `Tab` hijack so native `Tab` visits `Key → Value → Số? → Type chip → ⋯ → next row`; added `Alt+↓` shortcut from Key/Value to open Type menu. |
| **RFD-7** | MEDIUM | Type, row, and root menus use `role="menu"` without menu keyboard pattern. | Opening any menu focuses the checked/first item; added `ArrowDown`/`ArrowUp`, `Home`/`End`, prefix typeahead, `Tab` close, and `Esc` close + focus restore. |
| **RFD-8** | MEDIUM | Invalid number written to Raw as `0`, making it permanent on raw edit. | `serializeNodeValue` emits the user's raw number text verbatim (`036` stays `036`), immediately surfacing a syntax error in Raw JSON instead of substituting `0`. |
| **RFD-9** | MEDIUM | Columns don't line up across rows (D10 regression). | Fixed 4-column grid (`minmax(140px, 34%) minmax(0, 1fr) 9.5rem 44px`); `Số?` placed inside `.kv-val-adorn-wrap` as an end adornment. |
| **RFD-10** | MEDIUM | `role="alert"` on every row error + full repaint on every keystroke while invalid. | Removed `role="alert"` from `.kv-row-err`; `refreshValidationInPlace` updates DOM in place without replacing focused `<input>`; added single polite live region + error count summary in `#new-json-save-reason`. |
| **RFD-11** | LOW | `Backspace` in empty key deletes container/boolean/null rows and children. | Guarded key `Backspace` deletion with `isRowCompletelyBlank(found.row, 'object')`. |
| **RFD-12** | LOW | Nested labels lack parent context; orphan `<label for>` on bool/null/container; `.kv-null-pill` `aria-label` ignored; `.kv-nest` vi-only. | Added ancestor path prefix (`guest › ...`) to row/input `aria-label`s; removed orphan `<label>`s; added `.sr-only` label inside `.kv-null-pill`; made `.kv-nest` `aria-label` bilingual. |
| **RFD-13** | LOW | Switching root silently drops or invalidates keys. | Switching `Object → Array` with non-empty keys shows inline confirm banner (`{N} trường sẽ mất tên...`) + Undo toast. |
| **RFD-14** | LOW | Array paste tip says `key: value`; copy table mismatches; `null` string cleared on re-picking Text. | Array paste tip updated + line-per-item paste supported in arrays; copy table & i18n keys unified; `r.value === 'null'` only cleared when `prevType === 'null'`. |
| **RFD-15** | LOW | Typo in `makePositionalAriaLabel`: `Number.isFinite(colNum) >= 1`. | Restored `Number.isFinite(colNum) && colNum >= 1` (`mock.js:4463`). |
| **RFD-16** | LOW | Pair paste trims values (`pass:  abc ` loses trailing space). | `parseMultiLineKeyValuePaste` preserves value substring after `: ` / `=` verbatim without `.trim()`. |
| **RFD-17** | LOW | 390 px row height (~240 px) too tall; missing ~1250 px and deep-nesting screenshots. | Mobile (`<= 639 px`) uses compact 2-line grid (`Key` on line 1; `Value + Type chip + ⋯` on line 2, ~96 px/row); added `1250 px` and `deep-nesting` screenshots to `design-r2/`. |
| **RFD-18** | LOW | Design note out of sync with code. | Updated `docs/design/entry-editor.md` across §1–§6 to match exact r2 behaviour. |

---

## 7. Review r2 Findings (`RFD-19` .. `RFD-31` + Partial `RFD-10`, `RFD-13`, `RFD-18`) Resolution Summary

All 13 new findings from `review-fe-design-r2.md` (2 HIGH, 4 MEDIUM, 7 LOW) plus the 3 partial r1 items (`RFD-10`, `RFD-13`, `RFD-18`) are resolved in r3 (**0 skipped**):

| ID | Severity | Finding | Resolution in r3 |
|---|---|---|---|
| **RFD-19** | HIGH | Pasting a single-line value containing `:` or `=` (URL, base64 `==`, `10:30`) into an empty value field splits into a bogus row. | Value inputs never intercept single-line text; pair/line splitting on a value input requires `>= 2` non-empty lines. On key inputs, single-line pair splitting requires explicit `key: value` (colon + space, non-`http(s)`) or `key=value`. |
| **RFD-20** | HIGH | Switching `Array → Object` (root or nested) silently saves duplicate empty keys `{"":1,"":2}`. | Any container-kind switch (root or nested) clears `fromRaw` and `rawKeyLiteral` on direct children so `EMPTY_KEY`/`DUPLICATE_KEY` rules apply, and shows an inline confirmation prompt in both directions (`{N} phần tử cần đặt tên trường · {N} items need key names`). |
| **RFD-21** | MEDIUM | A middle row cleared by the user is saved as `"": ""` with no error. | In Object containers, any table-authored (`!fromRaw`) completely blank string row at any position is treated as a placeholder (`isEffectivePlaceholderRow`) and omitted on serialize. Raw-origin `{"":""}` stays preserved. Array middle blank items keep `""` with placeholder hint `(trống = "")`. |
| **RFD-22** | MEDIUM | A table validation error (`036` or empty Number) traps the user in Raw JSON tab. | Tracked `rawEditedSinceSwitch`; switching `Raw → Table` is blocked on syntax error *only* when the user actually edited the Raw textarea since switching from Table. Unedited Raw returns to Table cleanly. |
| **RFD-23** | MEDIUM | Changing a container row (`Object`/`Array`) to a scalar type drops its children without confirmation. | When leaving `Object`/`Array` with `>= 1` committed child, shows inline confirmation (`{N} trường con/phần tử con sẽ bị xoá`) + toast **Hoàn tác** (`Undo`). |
| **RFD-24** | MEDIUM | Footer `#new-json-save-reason` has `role="status"` and rewrites `innerHTML` on every keystroke (`RFD-10` leftover). | Removed `role="status"` from `#new-json-save-reason` (already exposed via Save's `aria-describedby`) and guarded `reasonEl.innerHTML` / `className` with `lastReasonHtml` / `lastReasonClass` so DOM mutates only when state text changes. |
| **RFD-25** | LOW | Inline prompt banner is neither announced nor focused on open. | Inner prompt wrapper uses `role="alert"`, opening focuses the first action button (`[data-kv-prompt-act]`), and dismissing (`Esc` or **Huỷ**) restores focus to the originating input/button. |
| **RFD-26** | LOW | `Tab` inside an open menu remounts the row before native `Tab` runs, losing focus to `BODY`. | `handleMenuKeydown` on `Tab` calls `closeAndRestoreFn(true)` so the trigger button is focused synchronously in the remounted DOM before native `Tab` advances to the next control. |
| **RFD-27** | LOW | "Lồng vào dòng này" replaces the row's value and invents key `"data"` when key is empty. | Renamed button to `Thay giá trị dòng này · Replace this row's value` and preserved `found.row.key` verbatim (leaving `""` empty so `EMPTY_KEY` flags it rather than inventing `"data"`). |
| **RFD-28** | LOW | `Enter` on a blank last row keeps adding blank rows; no keyboard way out of a nested container. | `Enter` on an untouched blank trailing placeholder row no longer appends another blank row; inside a nested container, `Enter` on a trailing blank placeholder outdents by removing the trailing blank row and focusing a new row after the parent container. |
| **RFD-29** | LOW | `refreshValidationInPlace` leaves stale row `aria-label`, key-space warning, and `Số?` `aria-label`. | Updated `refreshValidationInPlace` to sync row `aria-label`, dynamically insert/remove `#kv-warn-key-{id}` (wired to `aria-describedby`), and set the row-scoped `aria-label` on `Số?`. |
| **RFD-30** | LOW | At `390 px` coarse pointer, `⋯` (`44 px`) overflows `40 px` track; deep nesting wraps container pill to 3–4 lines. | Widened `< 640 px` action column track to `44px` in `.kv-row-grid` and `.kv-row-grid-arr`; added `.kv-pill-compact` (`Object (N)` / `Mảng (N)`) for `< 640 px` while keeping full bilingual text in `aria-label`. |
| **RFD-31** | LOW | Copy inconsistencies on add-row buttons; Shortcuts side card wraps `<kbd>` chips inconsistently. | Unified add buttons to `+ Thêm dòng · Add field` / `+ dòng · Add field` (Object) and `+ Thêm phần tử · Add item` / `+ phần tử · Add item` (Array); changed Shortcuts card items to `grid-cols-[minmax(0,1fr)_auto]`. |
| **RFD-10 / 13 / 18** | Partial | r1 partials (footer status churn, bilateral container switch confirm, design doc sync). | Fully closed via `RFD-24`, `RFD-20`/`RFD-23`, and this r3 design note update. |
