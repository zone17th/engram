# `@engram/content-fixtures` — Shared Content Fixtures (P04)

Shared test fixtures consumed by both Web (`apps/web`, Vitest) and API (`apps/api`, Go `testing`) suites for Phase 04 (Content).

## Layout

- `normalize.json` — Name/tag Unicode NFKC + whitespace + case-fold normalization vectors (Task 3a / Task 13).
- `quick-add.json` — Omnibox quick-add grammar vectors (Task 13).
- `json-corpus/` — Strict RFC 8259 JSON lossless corpus for `apps/web/lib/json` (Task 12, Task 16, Task 17; evidence rows `P04-A6` and `P04-A7`):
  - `manifest.json` — Index of all valid, BOM, and invalid UTF-8/JSON corpus files with metadata (`id`, `file`, `kind`, `eol`, `expectedBomStripped`, `expectedValidJson`, `description`).
  - `*.json` — Valid RFC 8259 JSON documents covering duplicate keys, integer-like key order (`"10"` before `"2"`), exact number lexemes (`9007199254740993`, `1e400`, `-0`, `0.10`), string escapes (`é`, `😀`, `\/`, `\n`, `\r\n`, `\t`, lone surrogate `\ud800`), prototype-pollution keys (`__proto__`, `constructor`, `hasOwnProperty`), CRLF/tab/mixed/lone-CR line endings, root primitives (`42`, `"ok"`, `null`, `true`), empty containers (`[]`, `{}`), mixed arrays, arrays of arrays, array-of-objects with duplicate keys in one row, 25-column array-of-objects (`+5 field`), and 10,000-level deep nesting (`deep-10000-array.json`, ~20 KB).
  - `two-bom.json` — Starts with two UTF-8 BOMs (`EF BB BF EF BB BF` + `{"a":1}`): stripping exactly one BOM leaves a second leading `U+FEFF`, which is rejected as non-whitespace by RFC 8259 JSON and offered as "Save as text" with the second BOM intact (Q8).
  - `invalid-utf8-*.bin` — Malformed UTF-8 byte sequences (`0xC3 0x28`, overlong `0xC0 0xAF`, CESU-8 surrogate `0xED 0xA0 0x80`) that must be rejected by strict UTF-8 decoding without emitting `U+FFFD`.

## Git line-ending invariant

`.gitattributes` marks `json-corpus/** -text -diff` so Git never rewrites `CRLF`, lone `CR`, or `UTF-8 BOM` bytes on checkout or commit.
