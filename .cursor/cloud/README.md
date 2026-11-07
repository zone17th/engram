# Cursor cloud runner for engram

Runs the heavy checks of `.github/workflows/ci.yml` on a Cursor Cloud Agent VM
instead of the developer machine or the production VPS. One VM per worktree
(per shard), driven through the Cloud Agents API v1. Ported from the uniwork
runner; engram-only.

| File | Role |
| --- | --- |
| `cloud-runner.mjs` | Host side: creates/reuses the agent, publishes the spec, waits, writes the report, pulls and deletes the logs. Node 20+, no dependencies. |
| `run-tests.sh` | VM side: one round = checkout, first-use install, dependency refresh, start, spec lines, log scrub, log push, one JSON line. |
| `provision-engram.sh` | VM toolchain as CI pins it: Go, Node 22, pnpm (packageManager), Docker + compose, golangci-lint, govulncheck, sqlc. Idempotent. |
| `install-engram.sh` | First use on a VM: provision, `pnpm install --frozen-lockfile`, Go modules, pinned images pulled. |
| `start-engram.sh` | Every round: dockerd up and usable, `.data/mail-sink`. |
| `specs/*.txt` | Ready specs mirroring the ci.yml jobs (see below). |
| `cloud.env` | Local only, gitignored, mode 600: `CURSOR_API_KEY=...`. Never commit it. |

## Where things live

- The VM runs the scripts of the env branch (`phase06/cloudrun`, then `develop` once
  merged; override with `CLOUD_RUNNER_ENV_BRANCH`), so any lane branch can be tested,
  even one without `.cursor/cloud/`.
- Spec: pushed to the public engram repo as `refs/test-specs/<lane>/<sha>` (commands
  only, nothing secret), deleted after the round.
- Logs: engram is PUBLIC, so the VM pushes them only to the PRIVATE
  `zone17th/engram-test-logs` as `refs/test-results/engram/<lane>/<sha>`. The runner
  fetches them next to the report (`<out>.logs/a.log`, `b.log`, ... one per spec line,
  first line = the command) and deletes the ref. Secret values of the VM and
  token-shaped strings are replaced with `[REDACTED]` before the push. Playwright
  artifacts are sanitized by `scripts/sanitize-e2e-artifacts.mjs` inside the e2e spec.

## Usage

The branch must be pushed: the runner tests what origin has at your HEAD.

```bash
R=<an engram checkout that has .cursor/cloud>/.cursor/cloud    # e.g. the phase06/cloudrun worktree
git push origin HEAD
node $R/cloud-runner.mjs test  --spec $R/specs/go-unit.txt --lane <lane> --out reports/<lane>/cloud-test-<seq>.md
node $R/cloud-runner.mjs suite --specs $R/specs/go-unit.txt,$R/specs/web-unit.txt --lane <lane> --out-dir reports/<lane>
node $R/cloud-runner.mjs status
node $R/cloud-runner.mjs close --all yes --lane <lane>         # when the lane is done: deletes VMs and refs
```

- Linux (bro): `CURSOR_API_KEY` in the environment, or `cloud.env` beside the script
  (`install -m 600` a copy of the host's existing file; never `cat` it).
- Windows (Git Bash): same commands; `node` must be 20+ (use the nvm v25 binary).
  Key from `cloud.env` beside the script, the env var, or the User/Machine scope.
  Prefix `MSYS_NO_PATHCONV=1` when an argument starts with `/`.
- Run it from inside the worktree you test: state lives in that worktree's git dir
  (`cloud-runner[.<shard>].json`) and vanishes with it.

Other commands: `ensure` (provision ahead, about 10 minutes), `collect [--shard n | --all yes]`
(finish a round after this machine died or after `--detach yes`), `--timeout s` (default
3600), `--model id[:k=v,...]` (default `grok-4.6:effort=high,fast=false`).
- Pending rounds created before the 40-char SHA cutover are preserved
  non-destructively by `collect` (exit `2` without deleting state or overwriting
  an existing report); drain them with `close --all yes` and re-run `test`.

## Spec format

One shell command per line, `#` comments, run from the repository root, each in its own
`bash -c` (no state between lines, stdin `/dev/null`). Capture `rc=$?` immediately before
printing the newline and marker (`; rc=$?; echo; echo NAME_EXIT=$rc; exit $rc` or
`; rc=$?; printf '\nNAME_EXIT=%s\n' "$rc"`) — never `; echo; echo NAME_EXIT=$?`, because
the bare `echo` resets `$?` to `0`. A line fails when its exit code is non-zero OR its log
holds a standalone `^[A-Z][A-Z0-9_]*_EXIT=<n>$` line with `n > 0` (worst marker wins), so
a line that ends with `printf '\nNAME_EXIT=%s\n' "$rc"` (shell exit 0) still fails when
`rc != 0`.

| spec | ci.yml job(s) |
| --- | --- |
| `go-unit.txt` | Go checks: gofmt, short race tests, vet, golangci-lint, govulncheck, build |
| `go-race-integration.txt` | Go integration tests (Testcontainers) and Content perf |
| `gen-nodiff.txt` | sqlc drift, OpenAPI client no-diff, Compose config and migration |
| `web-unit.txt` | Web checks: lint, typecheck, vitest, build |
| `e2e.txt` | `e2e-browser` job: E2E harness check, browser smoke + a11y, and `vault-prod` CSP check |
| `full.txt` | all five groups above in one round |
| `e2e-verify-true.txt` | optional shard: `e2e-auth-verify-true`, `e2e-journey-verify-true`, `e2e-content-verify-true`, `e2e-content-a11y`, `e2e-search-semantic` |
| `go-embedding-lag.txt` | optional benchmark shard: `embedding-lag` (`TestEmbeddingLagP95`) |

Runner self-test (no VM required): `node --test .cursor/cloud/runner.test.mjs`.
`suite` runs one VM per spec in parallel (faster, costs one VM each).

## Exit codes and reading results

`0` pass, `1` a test failed, `2` blocked or runner error (rerun once, then report).
The report (`--out`) has `stage_outcome`, `test_verdict`, per-line result and seconds,
cost, and the raw JSON. A summary "pass" is never evidence alone; check every log:

```bash
grep -rhoE '[A-Z][A-Z0-9_]*_EXIT=[1-9][0-9]*' reports/<lane>/cloud-test-<seq>.logs   # must be empty or explained
```

## Cost and VM hygiene

- Each `test` reuses the worktree's VM; a fresh VM provisions first (Docker, Go, Node,
  images; several minutes). Rough cost per uniwork measurements: 5 cents warm round,
  12 cents fresh; long e2e rounds cost more (see each report's cost line).
- Close every VM you start (`close --all yes --lane <lane>`), check `status` at the end.
  A stale state file whose agent is gone is replaced automatically on the next `test`.
- Never put hosts, keys, emails or tokens in a spec line: the spec ref is public.
