# Self-hosted web fonts

`app/fonts.ts` loads these files with `next/font/local`, so the build makes no font network request
(advisor-dec-052: `next/font/google` failed the docker build when Google answered with a dynamic
`fonts.gstatic.com/l/font?kit=...` URL). The exported variables (`--font-plus-jakarta`, `--font-inter`,
`--font-sometype`) and `display: swap` are unchanged, so `styles/tokens.css` and every consumer stay as they were.

All three families are licensed under the SIL Open Font License 1.1; each license is copied unchanged next to
its font (`OFL-<Family>.txt`).

## Source

Upstream: [google/fonts](https://github.com/google/fonts) at commit
`6157dfaa640ca5738b4d1a7070fe389c3036d7fc` (2026-10-29T15:08:01Z). Each download was checked against the git blob
SHA that the GitHub contents API lists for that commit.

| Family | Upstream file | Font version | Input sha256 |
| --- | --- | --- | --- |
| Inter | `ofl/inter/Inter[opsz,wght].ttf` | 4.001 (git-66647c0bb) | `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` |
| Plus Jakarta Sans | `ofl/plusjakartasans/PlusJakartaSans[wght].ttf` | 2.071 | `89b3fb38aa0d275d7a731d0d817a4f1622b316b4d7fbdedcf02ee9099ff68bc8` |
| Sometype Mono | `ofl/sometypemono/SometypeMono[wght].ttf` | 1.001 | `4095fd328c988392fb00ab867134e69beff0fc16de66ecdd9e7e232c16f16f25` |

Licenses: `ofl/inter/OFL.txt`, `ofl/plusjakartasans/OFL.txt`, `ofl/sometypemono/OFL.txt` from the same commit.

## Output

| File | Axes | Unicode subsets | Bytes | sha256 |
| --- | --- | --- | --- | --- |
| `Inter-Variable.woff2` | wght 100–900 (opsz pinned to 14) | latin, latin-ext, vietnamese | 142092 | `b6c33de18ca1f46b986be63dcf8c2f6e0660c092b5ea62245ce4aa9d1c80206a` |
| `PlusJakartaSans-Variable.woff2` | wght 200–800 | latin, latin-ext, vietnamese | 50740 | `0c575aecf0de8f80531fabab8f0b9b0cc5c504860a4d40a26b09cf84a003ceee` |
| `SometypeMono-Variable.woff2` | wght 400–700 (declared 400–500 in `fonts.ts`) | latin | 18296 | `563d72b76d4728bc7ec7599dc1349c94179b639ba8af963b047d757973d0cb35` |

Why these choices:

- Inter's opsz axis is pinned to 14 because `next/font/google` never requested opsz, so Google served
  the opsz=14 default. Keeping the axis would let `font-optical-sizing: auto` change how large text renders.
- Inter and Plus Jakarta Sans keep every glyph from Google's latin, latin-ext and vietnamese ranges. The old
  config asked for latin + vietnamese, and latin-ext costs little. All 90 glyphs in U+1EA0–1EF9 are present, as
  are ă ơ ư Đ đ ₫.
- Sometype Mono stays latin-only, as before. Upstream has no Vietnamese glyphs (2 of 90 in U+1EA0–1EF9), so the
  browser keeps falling back to `ui-monospace` for those characters, as it did before. `fonts.ts` declares
  weight `400 500`, matching the old `weight: ['400', '500']`.

## Rebuild

Tools: Python 3.12, `fonttools==4.68.0` and `brotli==1.2.1` in a throwaway venv. Neither is a project dependency.
With the three upstream TTFs in `$IN`, the following script reproduces the sha256 values above byte for byte.
It was run twice to confirm that:

```bash
set -euo pipefail
# google/fonts 6157dfa commit time; fixes head.modified so the output is deterministic
export SOURCE_DATE_EPOCH=1793286481
LATIN='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
LATIN_EXT='U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'
VIETNAMESE='U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB'
OPTS=(--flavor=woff2 --layout-features='*' --name-IDs='*' --name-languages='*' --notdef-outline)
python -m fontTools.varLib.instancer "$IN/Inter.ttf" opsz=14 -o "$OUT/Inter-opsz14.tmp.ttf"
python -m fontTools.subset "$OUT/Inter-opsz14.tmp.ttf" --unicodes="$LATIN,$LATIN_EXT,$VIETNAMESE" "${OPTS[@]}" --output-file="$OUT/Inter-Variable.woff2"
rm "$OUT/Inter-opsz14.tmp.ttf"
python -m fontTools.subset "$IN/PlusJakartaSans.ttf" --unicodes="$LATIN,$LATIN_EXT,$VIETNAMESE" "${OPTS[@]}" --output-file="$OUT/PlusJakartaSans-Variable.woff2"
python -m fontTools.subset "$IN/SometypeMono.ttf" --unicodes="$LATIN" "${OPTS[@]}" --output-file="$OUT/SometypeMono-Variable.woff2"
```

The unicode ranges are the ones Google Fonts' CSS API serves for each subset. `--name-IDs='*'` keeps the copyright
and license entries in each font's name table.
