#!/usr/bin/env bash
# One test round on an engram cloud runner VM (zone17th/engram), as a single
# command so the agent makes one tool call (every agent step re-reads the whole
# conversation, which is what a round costs). Run from the repository checkout:
#
#   run-tests.sh --branch B --sha S --lane L --spec-ref R --spec-sha256 H --log-repo URL [--profile engram] [--repo-url URL]
#   run-tests.sh --branch B --provision-only --log-repo URL [--profile engram] [--repo-url URL]
#
# Checks out origin/B, provisions the VM on first use (install-engram.sh),
# refreshes toolchains/dependencies when manifests or lockfiles change, starts
# docker (start-engram.sh), runs each spec line from the repo root without the
# agent's secrets in its environment, redacts secret values from logs and JSON
# fields (failing closed if redaction fails), publishes logs only to an
# allowlisted PRIVATE log repository under refs/test-results/engram/L/S, and
# prints one JSON report line on stdout.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
state=~/.engram-cloud/state
work_tmp=$(mktemp -d "${TMPDIR:-/tmp}/engram-run-tests.XXXXXXXXXX")
results="$work_tmp/results"
ran_file="$work_tmp/ran.jsonl"
: > "$ran_file"
spec_file=""
trap 'rm -rf "$work_tmp" "${spec_file:-}"' EXIT
mkdir -p "$state"

branch="" sha="" lane="" spec_ref="" spec_sha="" provision_only=false profile=engram log_repo_url="" repo_url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) branch=${2:-}; shift 2 ;;
    --sha) sha=${2:-}; shift 2 ;;
    --lane) lane=${2:-}; shift 2 ;;
    --spec-ref) spec_ref=${2:-}; shift 2 ;;
    --spec-sha256) spec_sha=${2:-}; shift 2 ;;
    --provision-only) provision_only=true; shift ;;
    --profile) profile=${2:-}; shift 2 ;;
    --log-repo) log_repo_url=${2:-}; shift 2 ;;
    --repo-url) repo_url=${2:-}; shift 2 ;;
    *) echo "run-tests.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

case "$profile" in
  engram)
    provision_sh=provision-engram.sh install_sh=install-engram.sh start_sh=start-engram.sh ;;
  *) echo "run-tests.sh: unknown profile $profile" >&2; exit 2 ;;
esac

# Fixed allowlist of PRIVATE log repositories (advisor-dec-P06-002).
norm_repo_url() {
  printf '%s' "${1:-}" \
    | sed -E 's#^https?://[^/@[:space:]]+@#https://#I; s#^git@github\.com:#https://github.com/#I; s#\.git/*$##I; s#/*$##' \
    | tr '[:upper:]' '[:lower:]'
}
is_allowed_log_repo() {
  local n
  n=$(norm_repo_url "${1:-}")
  case "$n" in
    https://github.com/zone17th/engram-test-logs|https://github.com/uniai-team/uniwork) return 0 ;;
    *) return 1 ;;
  esac
}

# Build secret-stripping args up front so checkout-controlled setup (install,
# provision, dependency refresh, start) and spec commands never inherit VM tokens.
secret_names="GH_TOKEN GITHUB_TOKEN CURSOR_API_KEY ${CLOUD_AGENT_ALL_SECRET_NAMES:-}"
secret_names=${secret_names//,/ }
unset_args=()
for s in $secret_names; do
  [ -n "$s" ] && unset_args+=(-u "$s")
done

provisioned=false fresh_install=false start_seconds=0 head="" notes="" log_repo=""

report() { # stage_outcome test_verdict log_ref
  STAGE=$1 VERDICT=$2 LOGREF=$3 LOGREPO=$log_repo HEAD_SHA=$head PROV=$provisioned START=$start_seconds \
  NOTES=$notes RAN=$ran_file SECRET_NAMES=$secret_names node -e '
    const fs = require("fs");
    const names = ["GH_TOKEN", "GITHUB_TOKEN", "CURSOR_API_KEY",
      ...(process.env.SECRET_NAMES || "").split(/\s+/),
      ...(process.env.CLOUD_AGENT_ALL_SECRET_NAMES || "").split(/[\s,]+/)].filter(Boolean);
    const values = [...new Set(names.map((n) => process.env[n]).filter((v) => v && v.length >= 8))];
    const tokenLike = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|key_[A-Za-z0-9]{20,})\b/g;
    const urlCred = /(\/\/[^\/\s:@]*:)[^@\s]+@/g;
    const redact = (input) => {
      let s = String(input ?? "");
      for (const v of values) s = s.split(v).join("[REDACTED]");
      return s.replace(tokenLike, "[REDACTED]").replace(urlCred, "$1[REDACTED]@");
    };
    const rawLines = fs.existsSync(process.env.RAN)
      ? fs.readFileSync(process.env.RAN, "utf8").split("\n").filter(Boolean)
      : [];
    const ran = rawLines.map((l) => JSON.parse(l)).map((r) => ({
      cmd: redact(r.cmd),
      result: r.result,
      duration_s: Number(r.duration_s),
      exit_code: Number(r.exit_code),
      failures: (r.failures || []).map((f) => ({
        test: redact(f.test),
        file: redact(f.file),
        msg: redact(f.msg),
      })),
    }));
    const failures = ran.filter((r) => r.result === "fail").flatMap((r) => r.failures);
    const logRepoClean = process.env.LOGREPO ? redact(process.env.LOGREPO) : "";
    console.log(JSON.stringify({
      sha: process.env.HEAD_SHA,
      stage_outcome: process.env.STAGE,
      test_verdict: process.env.VERDICT,
      provisioned: process.env.PROV === "true",
      start_seconds: Number(process.env.START),
      ran: ran.map(({ cmd, result, duration_s, exit_code }) => ({ cmd, result, duration_s, exit_code })),
      failures,
      not_run: [],
      log_ref: process.env.LOGREF || null,
      ...(logRepoClean ? { log_repo: logRepoClean } : {}),
      notes: redact(process.env.NOTES || ""),
    }));'
  rm -f "$ran_file"
}

if [ -n "$log_repo_url" ] && ! is_allowed_log_repo "$log_repo_url"; then
  notes="untrusted --log-repo $log_repo_url; refusing non-private destination"
  report failed blocked ""
  exit 0
fi

# --repo-url: Cursor could not open engram, so the VM booted on the private boot
# repository; work in a clone of engram under ~/work instead (once per VM).
home_origin=""
if [ -n "$repo_url" ]; then
  home_origin=$(git remote get-url origin 2>/dev/null || true)
  clone=~/work/$(basename "$repo_url" .git)
  if [ ! -d "$clone/.git" ]; then
    rm -rf "$clone" && mkdir -p ~/work
    if ! env "${unset_args[@]}" git clone -q "$repo_url" "$clone" > "$work_tmp/runner-clone.log" 2>&1; then
      notes="could not clone $repo_url"
      report failed blocked ""
      exit 0
    fi
  fi
  cd "$clone"
fi
root=$(git rev-parse --show-toplevel)
cd "$root"
export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH

if [ -n "$branch" ]; then
  if ! env "${unset_args[@]}" git fetch -q origin "$branch" || ! git reset -q --hard "origin/$branch"; then
    notes="could not check out origin/$branch"; report failed blocked ""; exit 0
  fi
  if ! git clean -qfdx -e .env -e node_modules -e '**/node_modules' 2>/dev/null; then
    sudo chown -R "$(id -u):$(id -g)" . 2>/dev/null || true
    git clean -qfdx -e .env -e node_modules -e '**/node_modules'
  fi
fi
head=$(git rev-parse HEAD | tr '[:upper:]' '[:lower:]')
if [ -n "$sha" ]; then
  sha_lc=$(printf '%s' "$sha" | tr '[:upper:]' '[:lower:]')
  if [ "${#sha_lc}" -ne 40 ] || [ "$head" != "$sha_lc" ]; then
    notes="sha mismatch: HEAD $head, wanted $sha"; report failed blocked ""; exit 0
  fi
fi

# Fingerprint both the provision script and the repo files from which it reads
# toolchain / image pins, plus all workspace manifests and lockfiles. Compare the
# full computed manifest text directly against the saved state file so added or
# removed input paths (or an older state schema) always invalidate the cache.
provision_inputs=("$here/$provision_sh")
for f in .github/workflows/ci.yml package.json pnpm-workspace.yaml apps/api/go.mod infra/image-pins.env; do
  [ -f "$f" ] && provision_inputs+=("$f")
done
locks=()
for f in package.json pnpm-workspace.yaml pnpm-lock.yaml apps/api/go.mod apps/api/go.sum apps/*/package.json packages/*/package.json; do
  [ -f "$f" ] && locks+=("$f")
done
prov_manifest=$(sha256sum "${provision_inputs[@]}")
locks_manifest=$(sha256sum "${locks[@]}")

if [ ! -f "$state/installed" ]; then
  if ! env "${unset_args[@]}" bash "$here/$install_sh" > "$work_tmp/runner-install.log" 2>&1; then
    notes="$install_sh failed: $(tail -3 "$work_tmp/runner-install.log" | tr '\n' ' ')"; report failed blocked ""; exit 0
  fi
  touch "$state/installed"; provisioned=true; fresh_install=true
  printf '%s\n' "$locks_manifest" > "$state/locks"
  printf '%s\n' "$prov_manifest" > "$state/provision"
elif [ "$(cat "$state/provision" 2>/dev/null || true)" != "$prov_manifest" ]; then
  if ! env "${unset_args[@]}" bash "$here/$provision_sh" > "$work_tmp/runner-provision.log" 2>&1; then
    notes="$provision_sh failed: $(tail -3 "$work_tmp/runner-provision.log" | tr '\n' ' ')"; report failed blocked ""; exit 0
  fi
  printf '%s\n' "$prov_manifest" > "$state/provision"; provisioned=true
fi
if [ "$fresh_install" = false ] && [ "$(cat "$state/locks" 2>/dev/null || true)" != "$locks_manifest" ]; then
  if ! env "${unset_args[@]}" bash -c 'pnpm install --frozen-lockfile && (cd apps/api && go mod download)' > "$work_tmp/runner-deps.log" 2>&1; then
    notes="dependency refresh failed: $(tail -3 "$work_tmp/runner-deps.log" | tr '\n' ' ')"; report failed blocked ""; exit 0
  fi
  printf '%s\n' "$locks_manifest" > "$state/locks"
fi

t0=$(date +%s)
if ! env "${unset_args[@]}" bash "$here/$start_sh" > "$work_tmp/runner-start.log" 2>&1; then
  notes="$start_sh failed: $(tail -3 "$work_tmp/runner-start.log" | tr '\n' ' ')"; report failed blocked ""; exit 0
fi
start_seconds=$(( $(date +%s) - t0 ))

if $provision_only; then report succeeded not_run ""; exit 0; fi

spec_file="$work_tmp/spec.txt"
if ! env "${unset_args[@]}" git fetch -q origin "$spec_ref" || ! git show FETCH_HEAD:spec.txt > "$spec_file" 2> /dev/null; then
  rm -f "$spec_file"
  notes="could not fetch spec $spec_ref"; report failed blocked ""; exit 0
fi
if [ "$(sha256sum "$spec_file" | cut -d' ' -f1)" != "$spec_sha" ]; then
  rm -f "$spec_file"
  notes="spec sha256 mismatch for $spec_ref"; report failed blocked ""; exit 0
fi

scrub_results_dir() {
  SECRET_NAMES=$secret_names RESULTS=$results node -e '
    const fs = require("fs"); const path = require("path");
    const names = ["GH_TOKEN", "GITHUB_TOKEN", "CURSOR_API_KEY",
      ...(process.env.SECRET_NAMES || "").split(/\s+/),
      ...(process.env.CLOUD_AGENT_ALL_SECRET_NAMES || "").split(/[\s,]+/)].filter(Boolean);
    const values = [...new Set(names.map((n) => process.env[n]).filter((v) => v && v.length >= 8))];
    const tokenLike = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|key_[A-Za-z0-9]{20,})\b/g;
    const urlCred = /(\/\/[^\/\s:@]*:)[^@\s]+@/g;
    for (const f of fs.readdirSync(process.env.RESULTS)) {
      const p = path.join(process.env.RESULTS, f);
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.isSymbolicLink()) {
        fs.rmSync(p, { recursive: true, force: true });
        continue;
      }
      let s = fs.readFileSync(p, "utf8");
      for (const v of values) s = s.split(v).join("[REDACTED]");
      s = s.replace(tokenLike, "[REDACTED]").replace(urlCred, "$1[REDACTED]@");
      fs.writeFileSync(p, s);
    }'
}

rm -rf "$results" && mkdir -p "$results"
n=0 any_fail=false
while IFS= read -r cmd <&3 || [ -n "$cmd" ]; do
  cmd=${cmd%$'\r'}
  case "$cmd" in ''|'#'*) continue ;; esac
  letter="" k=$n
  while [ "$k" -ge 26 ]; do letter="${letter}z"; k=$((k - 26)); done
  letter="$letter$(printf "\\$(printf '%03o' $((97 + k)))")"; n=$((n + 1))
  log="$results/$letter.log"
  echo "\$ $cmd" > "$log"
  t=$(date +%s)
  set +e
  (cd "$root" && env "${unset_args[@]}" bash -c "$cmd") < /dev/null >> "$log" 2>&1
  code=$?
  set -e
  dur=$(( $(date +%s) - t ))
  # Scrub the log file BEFORE extracting failure snippets, and fail closed if
  # the scrubber fails so unsanitized output can never enter ran_file or git.
  if ! scrub_results_dir > "$work_tmp/runner-scrub.log" 2>&1; then
    rm -f "$spec_file"
    rm -rf "$results"
    notes="log scrubber failed: $(tail -2 "$work_tmp/runner-scrub.log" | tr '\n' ' ')"
    report failed blocked ""
    exit 0
  fi
  # A spec line that prints a standalone NAME_EXIT=<n> line and exits 0 still
  # fails when its marker is non-zero (worst non-zero marker wins).
  if [ "$code" -eq 0 ]; then
    marker=$(tail -n +2 "$log" | tr -d '\r' | grep -E '^[A-Z][A-Z0-9_]*_EXIT=[0-9]+$' | sed 's/.*=//' | sort -n | tail -1 || true)
    if [ -n "$marker" ] && [ "$marker" -ne 0 ]; then code=$marker; fi
  fi
  result=pass; [ "$code" -eq 0 ] || { result=fail; any_fail=true; }
  CMD=$cmd RESULT=$result DUR=$dur CODE=$code LOG=$log node -e '
    const fs = require("fs");
    const lines = process.env.RESULT === "fail" ? fs.readFileSync(process.env.LOG, "utf8").split("\n") : [];
    const failures = [];
    for (const l of lines) {
      const go = l.match(/^\s*--- FAIL: (\S+)/);
      const vt = l.match(/^\s*(?:FAIL|×|✗)\s+(.+)/);
      const fork = l.match(/^\s*✘\s+(?:\d+\s+)?(.*›.*?)(?:\s+\([\d.]+m?s\))?$/) ?? l.match(/^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?$/)
        ?? l.match(/^\s*not ok \d+ - (.+)/);
      if (go || vt || fork) failures.push({ test: (go ?? vt ?? fork)[1].trim(), file: "", msg: "" });
      const at = l.match(/^\s+(\S+\.(?:go|ts|tsx|js|mjs):\d+):\s*(.*)$/);
      if (at && failures.length && !failures.at(-1).file) Object.assign(failures.at(-1), { file: at[1], msg: at[2].slice(0, 200) });
      if (failures.length >= 20) break;
    }
    if (process.env.RESULT === "fail" && failures.length === 0)
      failures.push({ test: process.env.CMD, file: "", msg: `exit ${process.env.CODE}; ${lines.filter(Boolean).slice(-3).join(" | ").slice(0, 300)}` });
    console.log(JSON.stringify({ cmd: process.env.CMD, result: process.env.RESULT,
      duration_s: Number(process.env.DUR), exit_code: Number(process.env.CODE), failures }));' >> "$ran_file"
done 3< "$spec_file"
rm -f "$spec_file"

if [ "$n" -eq 0 ]; then notes="spec has no commands"; report failed blocked ""; exit 0; fi

if ! scrub_results_dir > "$work_tmp/runner-scrub.log" 2>&1; then
  rm -rf "$results"
  notes="final log scrubber failed: $(tail -2 "$work_tmp/runner-scrub.log" | tr '\n' ' ')"
  report failed blocked ""
  exit 0
fi

log_ref="refs/test-results/engram/$lane/$head"
push_logs() { # $1 = target repo url -> writes chosen url to $work_tmp/runner-log-repo
  local target=${1:-} tried="" name val
  [ -n "$target" ] || return 1
  if ! is_allowed_log_repo "$target"; then
    echo "refusing non-allowlisted log repo $target"
    return 1
  fi
  if GIT_TERMINAL_PROMPT=0 git push -qf "$target" "HEAD:$log_ref"; then
    echo "$target" > "$work_tmp/runner-log-repo"; return 0
  fi
  for name in $(printf '%s\n' $secret_names | awk '!seen[$0]++'); do
    val=${!name:-}
    case "$val" in
      ghp_*|github_pat_*|gho_*|ghs_*) tried="$tried $name(${val:0:4})" ;;
      "") tried="$tried $name(unset)"; continue ;;
      *) continue ;;
    esac
    if PUSH_TOKEN=$val GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ASKPASS= GIT_CONFIG_COUNT=0 \
      git -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$PUSH_TOKEN"; }; f' \
      push -qf "$target" "HEAD:$log_ref"; then
      echo "$target" > "$work_tmp/runner-log-repo"; return 0
    fi
  done
  echo "log push to $target failed; tokens seen:${tried:- none}"
  return 1
}

rm -f "$work_tmp/runner-log-repo"
fallback_origin=""
if [ -n "$home_origin" ] && is_allowed_log_repo "$home_origin"; then
  fallback_origin=$home_origin
fi

if [ -z "$log_repo_url" ] && [ -z "$fallback_origin" ]; then
  rm -rf "$results"
  notes="no allowlisted private log repo; logs not published"
  report failed blocked ""
  exit 0
fi

if ! (cd "$results" && git init -q && git add -A \
      && git -c user.name=runner -c user.email=runner@local commit -qm "$lane $head" \
      && { push_logs "$log_repo_url" || push_logs "$fallback_origin"; }) > "$work_tmp/runner-push.log" 2>&1; then
  notes="log push failed: $(tail -2 "$work_tmp/runner-push.log" | tr '\n' ' ')"
  rm -f "$work_tmp/runner-log-repo"
  report failed blocked ""
  exit 0
fi

log_repo=$(sed -E "s#//[^/@]*@#//#" "$work_tmp/runner-log-repo")
rm -f "$work_tmp/runner-log-repo"

$any_fail && verdict=fail || verdict=pass
report succeeded "$verdict" "$log_ref"
