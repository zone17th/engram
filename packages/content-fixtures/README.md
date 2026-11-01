# `@engram/content-fixtures` — Shared Content Fixtures (P04)

Shared test fixtures consumed by both Web (`apps/web`, Vitest) and API (`apps/api`, Go `testing`) suites for Phase 04 (Content).

## Layout

- `normalize.json` — Name/tag/hint/query Unicode NFC → per-code-point lowercase → NFC (`advisor-dec-125`), whitespace collapse, punctuation strip, C0/C1/bidi/UTF-8 rejection, and rune-limit vectors (79 cases; Task 3a / Task 13).
- `quick-add.json` — Omnibox quick-add grammar and mode classification vectors (`{name, input, expected: {mode, name, tags, body, jsonCandidate, searchable, error?}}`, 67 cases; Task 13, plan mục 2.11, SPEC §3.4): URL in body/name (`(?!//)` colon rule), `a::b`, `a://b:c`, `a:\n//b`, `:abc`, `abc:`, `wifi:Abc123`, `10:30 họp` (Q13), `C#: x`, `wifi#tag: x`, multi-line, CRLF, lone CR, tab separators around name/tags (`wifi\t#tag: x`, `\twifi: x`, `wifi\t: x`) vs internal tab (`wi\tfi: secret`), full-width colon `：`, Vietnamese tags, `#` tag-filter (including after leading whitespace: `"  #nhà"`, `"\t#nhà: x"`) vs lone `#` / `##x` / `#a://b` tokens, word after tag (Q5), tag 50/51 runes and name 200/201 runes (both ASCII and astral emoji encoded with JSON `\uXXXX\uXXXX` surrogate-pair escapes so Go and TypeScript consume identical code points), Unicode whitespace, 20/21 tags, duplicate tag merge (`#Nhà #nhà`, `#J\u030c #j\u030c #\u01f0`), multi-line without `:`, 5 KB single line without `:`, and JSON object/array/empty-container/trailing-garbage/invalid/primitive body detection.
- `json-corpus/` — Strict RFC 8259 JSON lossless corpus for `apps/web/lib/json` (Task 12, Task 16, Task 17; evidence rows `P04-A6` and `P04-A7`):
  - `manifest.json` — Index of all valid, BOM, and invalid UTF-8/JSON corpus files with metadata (`id`, `file`, `kind`, `eol`, `expectedBomStripped`, `expectedValidJson`, `description`).
  - `*.json` — Valid RFC 8259 JSON documents covering duplicate keys, integer-like key order (`"10"` before `"2"`), exact number lexemes (`9007199254740993`, `1e400`, `-0`, `0.10`), string escapes (`é`, `😀`, `\/`, `\n`, `\r\n`, `\t`, lone surrogate `\ud800`), prototype-pollution keys (`__proto__`, `constructor`, `hasOwnProperty`), CRLF/tab/mixed/lone-CR line endings, root primitives (`42`, `"ok"`, `null`, `true`), empty containers (`[]`, `{}`), mixed arrays, arrays of arrays, array-of-objects with duplicate keys in one row, 25-column array-of-objects (`+5 field`), and 10,000-level deep nesting (`deep-10000-array.json`, ~20 KB).
  - `two-bom.json` — Starts with two UTF-8 BOMs (`EF BB BF EF BB BF` + `{"a":1}`): stripping exactly one BOM leaves a second leading `U+FEFF`, which is rejected as non-whitespace by RFC 8259 JSON and offered as "Save as text" with the second BOM intact (Q8).
  - `invalid-utf8-*.bin` — Malformed UTF-8 byte sequences (`0xC3 0x28`, overlong `0xC0 0xAF`, CESU-8 surrogate `0xED 0xA0 0x80`) that must be rejected by strict UTF-8 decoding without emitting `U+FFFD`.

## Git line-ending invariant

`.gitattributes` marks `json-corpus/** -text -diff` so Git never rewrites `CRLF`, lone `CR`, or `UTF-8 BOM` bytes on checkout or commit.
