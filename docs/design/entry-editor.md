# JSON / Key-Value Entry Editor — Design Note (P05-entryux)

**Ruling:** `advisor-dec-371` + `advisor-dec-370` (owner feedback: *"very hard to add a set of entry values; make UI nice, UX easy"*).  
**Mockup reference:** `mockups/item.html` (`#card-json-new`), `mockups/mock.js` (`SAK.initKvEntryEditor`), `mockups/tokens.css` (`.kv-*`).  
**Lossless invariant:** P04 lossless JSON rules (`docs/SPEC.md` §3.7, §7.4, ADR 0005) remain unchanged. No silent type auto-coercion ever occurs.

---

## 1. Overview & Entry States

Clicking **`+ JSON / bảng`** (`#btn-add-json`) opens `#card-json-new` directly in the **Bảng** (Table / Key-Value) view with **1 empty row** (`key = ""`, `value = ""`, `type = "string"`) and places focus inside the first **Key** input.

- **No initialization chooser step:** The previous `Khởi tạo: {} · Đối tượng rỗng / [] · Mảng rỗng` bar is removed. Root defaults to **Object** (`{}`). Switching the root container to **Mảng** (`[]`) is a secondary choice in the header dropdown menu (`[data-kv-root-menu-btn]`).
- **Header layout:** `[json badge] [Entry JSON mới · New JSON entry] [byte counter]` on the left; `[Bảng | JSON gốc]` segmented switch + `[Gốc: Object ▾]` menu on the right. Wraps cleanly without horizontal overflow at any viewport width (`390 px` – `1440 px`).
- **Row anatomy (Object / Key-Value):** `[Key input] [Value input / control] [Type chip ▾] [Row menu ⋯]`.
- **Row anatomy (Array root or nested Array):** `[# index badge] [Value input / control] [Type chip ▾] [Row menu ⋯]`. Clicking **`+ Thêm hàng`** adds a ready-to-type value row in one step.

| State | Description | Save button (`Ctrl+S`) |
|---|---|---|
| **Empty editor** | Newly opened with 1 blank row (`key = ""`, `value = ""`, `type = "string"`). No error border is shown on the initial blank row. | `disabled` with muted status: *"Nhập ít nhất một trường để lưu entry."* |
| **Filled rows (valid)** | 1+ rows with non-empty unique keys and valid values (including nested Object / Array containers). | `enabled` |
| **Inline validation error** | Any row has an empty key (when value is filled or multiple rows exist), duplicate key in the same object, or invalid RFC 8259 number lexeme. | `disabled` with visible `.kv-save-reason` explaining the first blocking error. |
| **Raw JSON tab (`JSON gốc`)** | Two-way synced `<textarea>` with **Định dạng** (`Format`) and live UTF-8 byte counter. Switching back to **Bảng** is blocked with an inline alert if Raw JSON has syntax errors. | `disabled` while syntax error or `> 256 KiB` (`262,144 B`). |
| **Dirty cancel prompt** | Pressing `Esc` or clicking **Huỷ** when rows have content shows an inline confirmation bar (`Tiếp tục sửa` / `Bỏ thay đổi`), never a modal. | Unchanged until user chooses. |

---

## 2. Explicit Types & Number Suggestion (`Số?`)

Every row defaults to **Văn bản** (`string`). Values are **never** silently coerced to numbers, booleans, or `null`.

- **Type chip menu (`[data-kv-act="toggle-type-menu"]`):** Explicitly switches row type between:
  1. `Văn bản` / `Text` (`string`) — default
  2. `Số` / `Number` (`number`) — verbatim RFC 8259 lexeme preserved (e.g. `9007199254740993`, `-0`)
  3. `true / false` / `Boolean` (`boolean`) — renders inline `[true | false]` segmented toggle
  4. `null` (`null`) — renders read-only `null` pill
  5. `Object` (`object`) — expands inline `.kv-nest` group with indent and its own `+ dòng` button
  6. `Mảng` / `Array` (`array`) — expands inline `.kv-nest` list with `#` index badges and its own `+ dòng mảng` button
- **Non-intrusive `Số?` suggestion chip:** When a row's type is `string` and its trimmed value is a valid RFC 8259 number lexeme (e.g. `"36"`), a dashed pill button **`Số? · Number?`** appears beside the value input. Clicking it explicitly switches the row type to `number`; ignoring it keeps the value as a JSON string `"36"`.
- **Clean type labels:** Type labels in both the new editor and existing table cell editors omit noisy literal hints like `("")`, `(0)`, `({})`, `([])`.

---

## 3. Keyboard Map & Paste Parsing

| Key / Gesture | Target | Action |
|---|---|---|
| `Enter` | Key input | Moves focus to Value input (or Type chip if container/null) on the same row. |
| `Tab` / `Shift+Tab` | Any control | Standard focus traversal: Key → Value → Type chip → Row menu `⋯` → next row. |
| `Enter` | Value input (non-last row) | Moves focus to the next row's Key input (or Value input in Array mode). |
| `Enter` | Value input (last row) | Appends a new empty row to the current container and focuses its first input. |
| `Backspace` | Empty Key or empty Value | When the entire row is blank (`key === ""` and `value === ""`) and the container has `> 1` row, removes the row and focuses the previous row's Value input. |
| `Paste` (`Ctrl/⌘+V`) | Key input (or empty Value) | Multi-line `key: value` or `key=value` text splits into individual string rows; pasting a valid JSON object/array populates the editor rows (preserving types). |
| `Ctrl+S` / `⌘+S` | Anywhere in card | Validates and triggers Save (when valid). |
| `Esc` | Menu open | Closes open Type menu, Row menu `⋯`, or Root menu and restores trigger focus. |
| `Esc` | Input / Card | Cancels immediately if clean; reveals inline discard confirmation if dirty. |

---

## 4. Inline Validation & Accessibility (a11y)

- **Never a modal:** All validation errors render inline directly beneath the offending input (`<p role="alert" class="kv-row-err" id="kv-err-...">`) and wire `aria-invalid="true"` + `aria-describedby="kv-err-..."` onto the `<input>`.
- **Validation rules:**
  1. `EMPTY_KEY`: Key is empty while Value is non-empty, row type is non-default, or container has multiple rows.
  2. `DUPLICATE_KEY`: Two or more rows in the same Object container share the same trimmed key name.
  3. `INVALID_NUMBER`: Row type is `number` and the value is empty or violates RFC 8259 number grammar (e.g. leading zero `036`, trailing dot `12.`).
  4. `RAW_SYNTAX_ERROR` / `OVER_CAP`: Raw JSON fails `parseJsonStrict` or UTF-8 byte length exceeds `262,144 B` (`256 KiB`).
- **Save button reason:** `#new-json-save-btn` references `#new-json-save-reason` via `aria-describedby`, which states the exact reason Save is disabled.
- **Responsive & Touch targets:**
  - At `<= 639 px` (`390 px` mobile viewport), `.kv-row-grid` stacks Key above Value above Controls (`1fr` single column), and `.kv-field-caption` labels (`Trường N`, `Giá trị N`) become visible above each input.
  - Under `@media (pointer: coarse)`, all interactive controls (`.kv-input`, `.kv-type-chip`, `.kv-num-suggest`, `.kv-bool-seg`, `.kv-container-pill`, `.kv-menu-btn`) enforce `min-height: 44px` and `min-width: 44px`.
  - Shortcut hints inside buttons use proper `<kbd class="kbd">` chips (`Huỷ` `<kbd>Esc</kbd>`, `Lưu` `<kbd>Ctrl+S</kbd>`) with no stray parentheses or spaces.

---

## 5. Copy Table (`vi` / `en`)

| Key / Role | Vietnamese (`vi`) | English (`en`) |
|---|---|---|
| Card title | `Entry JSON mới` | `New JSON entry` |
| View switcher | `Bảng` / `JSON gốc` | `Table` / `Raw JSON` |
| Root selector badge (Object) | `Gốc: Object` | `Object root` |
| Root selector badge (Array) | `Gốc: Mảng` | `Array root` |
| Root menu options | `Bảng khoá–giá trị (Object)` / `Mảng danh sách` | `Key-value object` / `Array list` |
| Column headers | `Trường` · `Giá trị` · `Kiểu` | `Key` · `Value` · `Type` |
| Key placeholder | `Tên trường (vd: ssid)` | `Key` |
| Value placeholder (text / number) | `Giá trị` / `Giá trị số (vd: 36)` | `Value` / `Number value` |
| Type labels | `Văn bản` · `Số` · `true / false` · `null` · `Object` · `Mảng` | `Text` · `Number` · `Boolean` · `null` · `Object` · `Array` |
| Number suggestion chip | `Số?` | `Number?` |
| Add row (Object / Array / Nested) | `+ Thêm dòng` / `+ Thêm hàng` / `+ dòng` | `Add row` / `Add row` / `Add nested row` |
| Row menu (`⋯`) | `Chèn dòng bên dưới` · `Chuyển lên` · `Chuyển xuống` · `Xoá dòng` | `Insert row below` · `Move up` · `Move down` · `Delete row` |
| Paste tip | `Mẹo: dán nhiều dòng key: value hoặc JSON để điền nhanh` | `Tip: paste key: value lines or JSON` |
| Error: Empty key | `Nhập tên trường hoặc xoá dòng trống.` | `Enter a field name or remove the empty row.` |
| Error: Duplicate key | `Trường “{key}” bị trùng trong cùng object.` | `Duplicate key “{key}” in the same object.` |
| Error: Invalid number | `Số không đúng định dạng JSON (ví dụ: 36, -1.5, 1e4; không có số 0 đứng đầu).` | `Invalid JSON number (e.g. 36, -1.5, 1e4; no leading zeros).` |
| Save disabled (blank) | `Nhập ít nhất một trường để lưu entry.` | `Enter at least one field to save.` |
| Save disabled (error prefix) | `Chưa thể lưu: {reason}` | `Cannot save: {reason}` |
| Footer buttons | `Huỷ` `<kbd>Esc</kbd>` · `Lưu` `<kbd>Ctrl+S</kbd>` | `Cancel` `<kbd>Esc</kbd>` · `Save` `<kbd>Ctrl+S</kbd>` |

---

## 6. Visual Audit r1 Defect Resolution (`D0`, `D1`, `D3`, `D4`, `D5`, `D9`, `D10`, `D12`, `D13`)

| Defect | Issue in Visual Audit r1 | Resolution in Redesigned Mockup |
|---|---|---|
| **D0** (High) | Object/array add-field form had no value input, wrapped key input to full width, defaulted to `null`, and showed `("")` / `(0)` hints. | New editor opens directly as `[key input][value input][type chip][row menu]` with `Văn bản` (`string`) default. Existing saved JSON card `+ Thêm trường` toolbar also includes both Key (`!w-[168px]`) and Value (`!w-[192px]`) inputs, defaults to `Văn bản · Text`, and strips all `("")`/`(0)`/`({})`/`([])` suffixes. Array `+ Thêm hàng` inserts a ready-to-type value cell and focuses it immediately. |
| **D1** (Medium) | Footer buttons rendered `Huỷ ( Esc )` / `Lưu ( Ctrl+S )` with stray spaces around parentheses. | All editor/composer Cancel & Save buttons render `<span>Huỷ · Cancel</span> <kbd class="kbd">Esc</kbd>` and `<span>Lưu · Save</span> <kbd class="kbd">Ctrl+S</kbd>` with no parentheses. |
| **D3** (Medium) | JSON header cramped with `Khởi tạo: {} · Đối tượng rỗng [] · Mảng rỗng` + view switch in one row. | Initialization chooser step removed. Header shows `json` badge + title + byte counter on the left, and `[Bảng | JSON gốc]` + `[Gốc: Object ▾]` secondary dropdown on the right. |
| **D4** (Medium) | After choosing "Đối tượng rỗng", editor showed `Object rỗng {}` + full-width key input + tiny `null` select + duplicate `Huỷ` above footer `Huỷ`. | Eliminated. Editor opens with 1 clean key-value row and a single card-footer `Huỷ Esc` / `Lưu Ctrl+S` bar. |
| **D5** (High) | Type select lacked `object` and `array` in table view; nested values could only be added via Raw JSON. | Both the new editor's per-row Type chip menu and existing card Type selects include `Object` and `Mảng · Array`. Selecting `Object` or `Mảng` expands an inline `.kv-nest` group with indent and its own `+ dòng` button. |
| **D9** (Medium) | Raw JSON editor used proportional font and flipped Save/Cancel toolbar to top. | `.json-raw-editor` uses `Sometype Mono` monospace; in `#card-json-new`, `Huỷ Esc` and `Lưu Ctrl+S` stay anchored in the persistent bottom `.kv-foot` across both `Bảng` and `JSON gốc` tabs, while `Định dạng` (`Format`) stays in the raw toolbar. |
| **D10** (Low) | Value column width jumped on edit; empty-string value had no visual affordance. | `.kv-row-grid` uses fixed proportional track `minmax(140px, 34%) minmax(0, 1fr) auto`; `.json-table .k` locks `width: 28%; min-width: 120px; max-width: 240px`. Empty string cells in saved tables render `(trống · empty)` muted italic affordance. |
| **D12** (Low) | Activating `+ JSON / bảng` by keyboard left focus on the trigger button. | Clicking/activating `#btn-add-json` immediately calls `newJsonEditor.focusFirstInput()`, focusing `#kv-key-r1` (or value input in Array mode). |
| **D13** (Low) | Cell `aria-label` was only `"Row 1, column 2"`; disabled Save had no visible reason. | Saved table cells include the field name in `aria-label` (`Giá trị của ssid (hàng 1) · Value for ssid (row 1)`). `#new-json-save-btn` binds `aria-describedby="new-json-save-reason"`, which displays the live reason whenever Save is disabled. |
