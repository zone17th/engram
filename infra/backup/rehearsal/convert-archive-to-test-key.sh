#!/usr/bin/env bash
# Convert a copy of an engram PITR archive (base/ + wal/) from the backup key to a throwaway TEST key
# (P06 Task 9/10, R1-11, Task 21c). Owner PC only for production archives: the production private key never
# leaves it; bro and the cloud runner only ever see test-key copies.
#
#   convert-archive-to-test-key.sh SRC_DIR DST_DIR TEST_FPR
#     SRC_GNUPGHOME  keyring holding the SOURCE private key (production key on the owner PC)
#     DST_GNUPGHOME  keyring holding the TEST public key TEST_FPR
#
# For every file: verify the original sidecar first (base: sha256 of the encrypted file; WAL: encrypted digest on
# line 2, then the plaintext digest on line 1 while streaming), decrypt -> re-encrypt to TEST_FPR in a pipe (no
# plaintext on disk), write a NEW sidecar for the test copy (base: new encrypted digest; WAL: same plaintext
# digest + new encrypted digest), publish atomically under the SAME source-timestamped name. SRC_DIR is only read.
# Exit 0 = every file converted and verified; any mismatch = exit 1 and the partial copy is removed.
set -euo pipefail
umask 077

if [ "$#" -ne 3 ]; then
  echo "usage: $0 SRC_DIR DST_DIR TEST_FPR (env SRC_GNUPGHOME, DST_GNUPGHOME)" >&2
  exit 2
fi
src="$1"
dst="$2"
test_fpr="$3"
: "${SRC_GNUPGHOME:?SRC_GNUPGHOME (source private key) is required}"
: "${DST_GNUPGHOME:?DST_GNUPGHOME (test public key) is required}"
if [ ! -d "$src/base" ] || [ ! -d "$src/wal" ]; then echo "SRC_DIR needs base/ and wal/" >&2; exit 2; fi
[ "$(cd "$src" && pwd)" != "$(mkdir -p "$dst" && cd "$dst" && pwd)" ] || { echo "DST_DIR must differ from SRC_DIR" >&2; exit 2; }
GNUPGHOME="$DST_GNUPGHOME" gpg --batch --list-keys "$test_fpr" >/dev/null 2>&1 || { echo "test key $test_fpr not in DST_GNUPGHOME" >&2; exit 2; }
mkdir -p "$dst/base" "$dst/wal"

tmp=""
trap '[ -n "$tmp" ] && rm -f "$tmp" "$tmp.sha" "$tmp.plain"' EXIT

reencrypt() { # in out -> stdout: sha256 of the decrypted (gunzip'ed when $3=wal) plaintext stream
  local in="$1" out="$2" kind="$3"
  if [ "$kind" = wal ]; then
    GNUPGHOME="$SRC_GNUPGHOME" gpg --batch --quiet --decrypt "$in" \
      | gunzip -c | tee >(sha256sum | awk '{print $1}' >"$out.plain") | gzip -c \
      | GNUPGHOME="$DST_GNUPGHOME" gpg --batch --yes --quiet --trust-model always --encrypt --recipient "$test_fpr" --output "$out"
  else
    GNUPGHOME="$SRC_GNUPGHOME" gpg --batch --quiet --decrypt "$in" \
      | GNUPGHOME="$DST_GNUPGHOME" gpg --batch --yes --quiet --trust-model always --encrypt --recipient "$test_fpr" --output "$out"
  fi
}

n_base=0
n_wal=0
for f in "$src"/base/engram-base-*.tar.gz.gpg; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  (cd "$src/base" && sha256sum -c --quiet "$name.sha256") || { echo "source base checksum mismatch: $name" >&2; exit 1; }
  tmp="$dst/base/$name.partial"
  reencrypt "$f" "$tmp" base
  sha="$(sha256sum "$tmp" | awk '{print $1}')"
  printf '%s  %s\n' "$sha" "$name" >"$tmp.sha"
  sync -f "$tmp" "$tmp.sha"
  mv -T "$tmp.sha" "$dst/base/$name.sha256"
  mv -T "$tmp" "$dst/base/$name"
  tmp=""
  n_base=$((n_base + 1))
done

for f in "$src"/wal/*--*.gz.gpg; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  [ -f "$f.sha256" ] || { echo "source WAL without sidecar: $name" >&2; exit 1; }
  want_plain="$(awk 'NR == 1 {print $1}' "$f.sha256")"
  wal_name="$(awk 'NR == 1 {print $2}' "$f.sha256")"
  want_enc="$(awk 'NR == 2 {print $1}' "$f.sha256")"
  if [ -z "$want_enc" ] || [ "$(sha256sum "$f" | awk '{print $1}')" != "$want_enc" ]; then
    echo "source WAL encrypted digest mismatch: $name" >&2
    exit 1
  fi
  tmp="$dst/wal/$name.partial"
  reencrypt "$f" "$tmp" wal
  for _ in $(seq 1 50); do [ -s "$tmp.plain" ] && break; sleep 0.1; done
  [ "$(cat "$tmp.plain")" = "$want_plain" ] || { echo "source WAL plaintext digest mismatch: $name" >&2; exit 1; }
  enc="$(sha256sum "$tmp" | awk '{print $1}')"
  printf '%s  %s\n%s  %s\n' "$want_plain" "$wal_name" "$enc" "$name" >"$tmp.sha"
  sync -f "$tmp" "$tmp.sha"
  mv -T "$tmp.sha" "$dst/wal/$name.sha256"
  mv -T "$tmp" "$dst/wal/$name"
  rm -f "$tmp.plain"
  tmp=""
  n_wal=$((n_wal + 1))
done
sync -f "$dst/base" "$dst/wal"
echo "convert-archive-to-test-key: bases=$n_base wal=$n_wal -> $dst (recipient $test_fpr)"
