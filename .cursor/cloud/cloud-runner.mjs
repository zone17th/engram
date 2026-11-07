#!/usr/bin/env node
// Drives one Cursor cloud agent per git worktree of zone17th/engram as a test
// runner, through the Cloud Agents API v1. Ported from the uniwork runner
// (same commands, state, pending/collect and exit codes); engram-only.
//
// The worktree pushes its branch; this script publishes the spec as
// refs/test-specs/<lane>/<sha> on engram (commands only, deleted after the
// round), asks the runner VM to check out that exact commit, run the listed
// commands and answer with one JSON block. engram is PUBLIC, so the VM pushes
// its logs to the PRIVATE log repository (LOG_REPO_URL) as
// refs/test-results/engram/<lane>/<sha>; this script fetches them, writes a
// Markdown report and deletes the ref.
//
//   node cloud-runner.mjs ensure  [--branch b] [--model m]
//   node cloud-runner.mjs test    --spec file [--lane slug] [--shard name] [--out report.md] [--timeout s] [--detach yes]
//   node cloud-runner.mjs suite   --specs a.txt,b.txt,... [--lane slug] [--out-dir dir] [--timeout s] [--detach yes]
//   node cloud-runner.mjs collect [--shard name | --all yes] [--timeout s]
//   node cloud-runner.mjs status
//   node cloud-runner.mjs close   [--lane slug] [--shard name | --all yes]
//
// A started round is recorded as `pending` in the state file before anything
// waits on it, so the cloud run survives this machine going down: `collect`
// (from the same worktree) waits for or reads that run, pulls its logs and
// writes the report the interrupted `test` would have written. `--detach yes`
// starts the round(s) and exits at once; collect them later.
//
// Run it from inside an engram worktree. State lives in that worktree's git dir
// (cloud-runner.json, or cloud-runner.<shard>.json for a shard), so it
// disappears with the worktree. A shard is a separate agent (its own VM) of the
// same worktree and publishes to refs/test-results/engram/<lane>-<shard>/<sha>;
// suite runs one shard per spec file in parallel and exits with the worst
// result. A fresh VM provisions itself (install-engram.sh) on its first run;
// later runs are follow-ups on the same warm VM. The VM takes the runner
// scripts from ENV_BRANCH of engram (CLOUD_RUNNER_ENV_BRANCH overrides), so
// lane branches that predate .cursor/cloud still run.
//
// Exit codes: 0 pass, 1 tests failed, 2 blocked or runner error.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const API = "https://api.cursor.com/v1";
const REPO_URL = "https://github.com/zone17th/engram";
// Private: runner logs never land in the public repository (advisor-dec-P06-002).
const LOG_REPO_URL = "https://github.com/zone17th/engram-test-logs";
const LOG_PREFIX = "refs/test-results/engram";
// The branch whose .cursor/cloud the VM runs; develop once this lane merges.
const ENV_BRANCH = process.env.CLOUD_RUNNER_ENV_BRANCH || "phase06/cloudrun";
// Same default as the uniwork runner (user 2026-10-02). --model takes
// "<id>[:param=value,...]", e.g. "composer-2.5" or "grok-4.6:effort=medium".
const DEFAULT_MODEL = "grok-4.6:effort=high,fast=false";

function modelSpec(text) {
  const [id, params = ""] = text.split(":");
  const list = params.split(",").filter(Boolean).map((p) => {
    const [pid, value] = p.split("=");
    return { id: pid, value };
  });
  return list.length ? { id, params: list } : { id };
}
const POLL_MS = Number(process.env.CLOUD_RUNNER_POLL_MS || 20_000);

// Refreshes the runner scripts from ENV_BRANCH into ~/.engram-cloud (nothing
// lands in the tested checkout), then hands the whole round to run-tests.sh,
// so the agent makes one tool call per round.
const REFRESH = [
  "mkdir -p ~/.engram-cloud",
  `git fetch -q origin ${ENV_BRANCH}`,
  "git archive FETCH_HEAD .cursor/cloud | tar -x -C ~/.engram-cloud",
].join(" && ");

function usage(msg) {
  if (msg) console.error(`cloud-runner: ${msg}`);
  console.error("usage: cloud-runner.mjs ensure|test|suite|collect|status|close [--branch b] [--spec f] [--specs a,b] [--lane s] [--shard n] [--out f] [--out-dir d] [--model m] [--timeout s] [--all yes] [--detach yes]");
  process.exit(2);
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith("--")) usage(`unexpected argument ${a}`);
    opts[a.slice(2)] = rest[i + 1];
    i += 1;
  }
  return { cmd, opts };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const normUrl = (u) => String(u).trim().replace(/^git@github\.com:/i, "https://github.com/")
  .replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();

// "origin" when the cwd's origin is engram, else its URL, so spec refs always
// reach the repository the VM checks out.
function repoRemote() {
  let origin = "";
  try { origin = git("remote", "get-url", "origin"); } catch { /* no origin */ }
  return origin && normUrl(origin) === normUrl(REPO_URL) ? "origin" : REPO_URL;
}
const REMOTE = repoRemote();

// CURSOR_API_KEY from the environment, else from cloud.env beside this script
// (gitignored, mode 600; `CURSOR_API_KEY=...` line), else the Windows user scope.
function apiKey() {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  const envFile = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "cloud.env");
  if (existsSync(envFile)) {
    const m = /^\s*CURSOR_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/m.exec(readFileSync(envFile, "utf8"));
    if (m) return m[1];
  }
  if (process.platform === "win32") {
    for (const scope of ["User", "Machine"]) {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
        `[Environment]::GetEnvironmentVariable('CURSOR_API_KEY','${scope}')`], { encoding: "utf8" });
      const v = (r.stdout || "").trim();
      if (v) return v;
    }
  }
  usage("CURSOR_API_KEY is not set");
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey()}:`).toString("base64")}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // A proxy page ("upstream connect error ...") instead of the API's JSON.
    const err = new Error(`${method} ${path} -> ${res.status} non-JSON ${text.slice(0, 120)}`);
    err.status = res.ok ? 502 : res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shardName(shard) {
  if (shard && !/^[A-Za-z0-9._-]{1,30}$/.test(shard)) usage(`bad shard name ${shard}`);
  return shard || "";
}

function statePrefix() {
  return "cloud-runner";
}

function statePath(shard) {
  const name = shardName(shard) ? `${statePrefix()}.${shard}.json` : `${statePrefix()}.json`;
  return join(resolve(git("rev-parse", "--git-dir")), name);
}

function loadState(shard) {
  const p = statePath(shard);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function saveState(s, shard) {
  writeFileSync(statePath(shard), `${JSON.stringify(s, null, 2)}\n`);
}

// Every runner state file of this worktree for the selected repository as
// [shard ("" = default runner), path].
function allStates() {
  const dir = resolve(git("rev-parse", "--git-dir"));
  const prefix = statePrefix();
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}.`))
    .map((f) => [/^\.(?:([A-Za-z0-9._-]+)\.)?json$/.exec(f.slice(prefix.length)), f])
    .filter(([m]) => m)
    .map(([m, f]) => [m[1] || "", join(dir, f)]);
}

function laneSlug(opts, branch) {
  const base = opts.lane || branch.replace(/^[a-z]+\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
  return opts.shard ? `${base}-${opts.shard}` : base;
}

async function waitRun(agentId, runId, timeoutS, startedAt = Date.now()) {
  const deadline = startedAt + timeoutS * 1000;
  for (;;) {
    let run;
    try {
      run = await api("GET", `/agents/${agentId}/runs/${runId}`);
    } catch (e) {
      // Transient API or network failure: the run goes on, keep polling until the deadline.
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      console.error(`cloud-runner: poll failed (${e.message.slice(0, 120)}); retrying`);
      run = { status: "UNKNOWN" };
    }
    if (["FINISHED", "ERROR", "CANCELLED", "EXPIRED"].includes(run.status)) return run;
    if (Date.now() > deadline) {
      await api("POST", `/agents/${agentId}/runs/${runId}/cancel`).catch(() => {});
      return { ...run, status: "TIMEOUT" };
    }
    await sleep(POLL_MS);
  }
}

async function agentAlive(state) {
  if (!state?.agentId) return false;
  try {
    const a = await api("GET", `/agents/${state.agentId}`);
    return a.status !== "ARCHIVED";
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

// Returns { agentId, runId } of a new agent on engram at `branch`.
async function createAgent(branch, model, prompt) {
  const r = await api("POST", "/agents", {
    name: `runner engram ${branch}`.slice(0, 80),
    prompt: { text: prompt },
    model: modelSpec(model),
    repos: [{ url: REPO_URL, startingRef: branch }],
    env: { type: "cloud" },
    autoCreatePR: false,
  });
  return { agentId: r.agent.id, runId: r.run.id };
}

async function sendRun(agentId, prompt) {
  for (;;) {
    try {
      const r = await api("POST", `/agents/${agentId}/runs`, { prompt: { text: prompt } });
      return (r.run ?? r).id;
    } catch (e) {
      if (e.status !== 409) throw e;
      await sleep(POLL_MS); // agent_busy: one run at a time
    }
  }
}

function oneCommandPrompt(args) {
  return `You are a test runner. Run exactly one command, from the repository root,
and wait for it to finish (up to 45 minutes on a new VM). Do not run anything
else, do not edit, commit or push any file, do not open a PR, and do not look
into failures:

    ${REFRESH} && bash ~/.engram-cloud/.cursor/cloud/run-tests.sh ${args} --log-repo ${LOG_REPO_URL}

The last line it prints is a JSON object. Reply with only that object, unchanged,
inside one \`\`\`json fence. If it printed no JSON, reply inside the fence with
{"stage_outcome": "failed", "test_verdict": "blocked", "notes": "<its last 3 output lines>"}.`;
}

function ensurePrompt(branch) {
  return oneCommandPrompt(`--branch ${branch} --provision-only`);
}

// Publishes the spec as refs/test-specs/<lane>/<sha> (a one-file commit) so the
// agent passes a short ref and a hash instead of retyping a long base64 string,
// which a model can corrupt. Returns { ref, sha256 }.
function publishSpec(lane, sha, commands) {
  const text = `${commands.join("\n")}\n`;
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["mktree"], { input: `100644 blob ${blob}\tspec.txt\n`, encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["commit-tree", tree, "-m", `spec ${lane} ${sha}`],
    { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "runner", GIT_AUTHOR_EMAIL: "runner@local",
      GIT_COMMITTER_NAME: "runner", GIT_COMMITTER_EMAIL: "runner@local" } }).trim();
  const ref = `refs/test-specs/${lane}/${sha}`;
  git("push", "-q", "-f", REMOTE, `${commit}:${ref}`);
  return { ref, sha256: createHash("sha256").update(text).digest("hex") };
}

function testPrompt({ branch, sha, lane, spec }) {
  return oneCommandPrompt(`--branch ${branch} --sha ${sha} --lane ${lane} --spec-ref ${spec.ref} --spec-sha256 ${spec.sha256}`);
}

function extractReport(result) {
  const blocks = [...String(result ?? "").matchAll(/```json\s*([\s\S]*?)```/g)];
  if (blocks.length === 0) return null;
  try {
    return JSON.parse(blocks[blocks.length - 1][1]);
  } catch {
    return null;
  }
}

async function costCents(agentId) {
  try {
    const u = await api("GET", `/agents/${agentId}/usage`);
    return u.cost?.chargedCents ?? null;
  } catch {
    return null;
  }
}

function writeReport(out, meta, rep, rawResult) {
  const rows = (rep?.ran ?? []).map((r) => `| \`${r.cmd}\` | ${r.result} | ${r.duration_s} |`).join("\n");
  const fails = (rep?.failures ?? []).map((f) => `- \`${f.test}\` ${f.file ?? ""}: ${f.msg}`).join("\n");
  const md = `# Cloud test report: ${meta.lane} @ ${meta.sha}

- stage_outcome: **${rep?.stage_outcome ?? "failed"}**
- test_verdict: **${rep?.test_verdict ?? "blocked"}**
- branch: \`${meta.branch}\`; agent \`${meta.agentId}\`; run \`${meta.runId}\` (${meta.runStatus}, ${Math.round((meta.durationMs ?? 0) / 1000)} s)
- provisioned this run: ${rep?.provisioned ?? "?"}; start_seconds: ${rep?.start_seconds ?? "?"}
- cost of this run: ${meta.costCents == null ? "unknown" : `${meta.costCents.toFixed(2)} cents`}
- logs: ${meta.logsDir ?? "not fetched"} (ref \`${rep?.log_ref ?? "none"}\`)

## Ran

| command | result | seconds |
| --- | --- | --- |
${rows || "| (none) | | |"}

## Failures

${fails || "None reported."}

## Not run

${(rep?.not_run ?? []).map((n) => `- ${n}`).join("\n") || "Nothing."}

## Notes

${rep?.notes || "None."}

## Raw report

\`\`\`json
${rep ? JSON.stringify(rep, null, 2) : String(rawResult ?? "").slice(0, 4000)}
\`\`\`
`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
}

// Fetches the results commit from the private log repository, writes each file
// with `git show` (no tar: Windows' bsdtar does not read stdin by default), then
// deletes the ref locally and in the log repository.
function fetchLogs(ref, dir) {
  const remote = LOG_REPO_URL;
  try {
    // Shards of one suite fetch from the same repository at once; retry a
    // fetch that lost a lock race.
    for (let attempt = 1; ; attempt += 1) {
      try {
        git("fetch", "-q", remote, `${ref}:${ref}`);
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        execFileSync(process.execPath, ["-e", `setTimeout(() => {}, ${attempt * 3000})`]);
      }
    }
    for (const name of git("ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean)) {
      const file = join(dir, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, execFileSync("git", ["show", `${ref}:${name}`], { maxBuffer: 1 << 30 }));
    }
    git("update-ref", "-d", ref);
    try { git("push", "-q", remote, `:${ref}`); } catch { /* close retries */ }
    return dir;
  } catch (e) {
    console.error(`cloud-runner: could not fetch logs from ${ref}: ${e.message}`);
    return null;
  }
}

async function cmdEnsure(opts) {
  const branch = opts.branch || git("rev-parse", "--abbrev-ref", "HEAD");
  let state = loadState(opts.shard);
  if (await agentAlive(state)) {
    console.log(`runner ready: ${state.agentId} (${state.branch})`);
    return 0;
  }
  const model = opts.model || DEFAULT_MODEL;
  const { agentId, runId } = await createAgent(branch, model, ensurePrompt(branch));
  state = { agentId, branch, model, lane: laneSlug(opts, branch), shard: shardName(opts.shard), createdAt: new Date().toISOString() };
  saveState(state, opts.shard);
  console.log(`runner created: ${agentId}; provisioning (about 10 min)`);
  const run = await waitRun(agentId, runId, Number(opts.timeout || 1800));
  const rep = extractReport(run.result);
  console.log(`provision: ${run.status} ${rep?.stage_outcome ?? "no report"} ${rep?.notes ?? ""}`);
  return run.status === "FINISHED" && rep?.stage_outcome === "succeeded" ? 0 : 2;
}

async function cmdTest(opts) {
  if (!opts.spec) usage("test needs --spec");
  const commands = readFileSync(opts.spec === "-" ? 0 : opts.spec, "utf8")
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (commands.length === 0) usage("spec has no commands");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const sha = git("rev-parse", "--short=8", "HEAD");
  const remote = git("ls-remote", REMOTE, `refs/heads/${branch}`).split(/\s+/)[0] ?? "";
  if (!remote.startsWith(git("rev-parse", "HEAD").slice(0, 12))) {
    usage(`engram:${branch} is not at HEAD ${sha}; push the branch first`);
  }
  let state = loadState(opts.shard);
  if (state?.pending) {
    usage(`${shardName(opts.shard) || "default runner"} has an uncollected run ${state.pending.runId} (${state.pending.sha}); run collect first`);
  }
  const lane = laneSlug(opts, branch);
  const spec = publishSpec(lane, sha, commands);
  const prompt = testPrompt({ branch, sha, lane, spec });
  const alive = await agentAlive(state);
  const before = alive ? await costCents(state.agentId) : 0;
  let agentId;
  let runId;
  try {
    if (alive) {
      agentId = state.agentId;
      runId = await sendRun(agentId, prompt);
    } else {
      ({ agentId, runId } = await createAgent(branch, opts.model || DEFAULT_MODEL, prompt));
    }
  } catch (e) {
    // No run will read the spec: drop its ref.
    try { git("push", "-q", REMOTE, `:${spec.ref}`); } catch { /* best effort */ }
    throw e;
  }
  if (!alive) {
    state = { agentId, branch, model: opts.model || DEFAULT_MODEL, lane, shard: shardName(opts.shard), createdAt: new Date().toISOString() };
  }
  // Saved before any wait: this is what collect resumes after a crash or shutdown.
  state.pending = {
    runId, sha, branch, lane, specRef: spec.ref, costBefore: before,
    out: resolve(opts.out || join("reports", lane, `cloud-test-${sha}.md`)),
    timeoutS: Number(opts.timeout || 3600), startedAt: Date.now(),
  };
  saveState(state, opts.shard);
  console.log(`run ${runId} on ${agentId} for ${sha}`);
  if (opts.detach) {
    console.log(`detached; collect later with: node ${process.argv[1]} collect${opts.shard ? ` --shard ${opts.shard}` : ""}`);
    return 0;
  }
  return finishPending(state, opts.shard);
}

// Waits for the state's pending run (its own deadline counts from the start),
// pulls the logs, writes the report and clears `pending`. Exit code as test.
async function finishPending(state, shard, timeoutOverride) {
  const p = state.pending;
  const run = await waitRun(state.agentId, p.runId, Number(timeoutOverride || p.timeoutS), timeoutOverride ? Date.now() : p.startedAt);
  const rep = extractReport(run.result);
  const after = await costCents(state.agentId);
  let logsDir = null;
  // Only the private log repository is trusted as a log source.
  if (rep?.log_ref && rep.log_ref.startsWith(`${LOG_PREFIX}/`)) {
    logsDir = fetchLogs(rep.log_ref, p.out.replace(/\.md$/, ".logs"));
  }
  try { git("push", "-q", REMOTE, `:${p.specRef}`); } catch { /* best effort */ }
  const valid = rep && String(rep.sha ?? "").slice(0, 7) === p.sha.slice(0, 7);
  writeReport(p.out, {
    lane: p.lane, sha: p.sha, branch: p.branch, agentId: state.agentId, runId: p.runId, runStatus: run.status,
    durationMs: run.durationMs, costCents: after == null || p.costBefore == null ? null : after - p.costBefore, logsDir,
  }, valid ? rep : { ...(rep ?? {}), stage_outcome: "failed", test_verdict: "blocked",
    notes: `${rep ? `sha mismatch (${rep.sha})` : "no JSON report"}; run ${run.status}. ${rep?.notes ?? ""}` }, run.result);
  console.log(`report: ${p.out}`);
  state.last = { runId: p.runId, sha: p.sha, out: p.out, runStatus: run.status, verdict: valid ? rep.test_verdict : "blocked" };
  delete state.pending;
  saveState(state, shard);
  if (!valid || run.status !== "FINISHED" || rep.stage_outcome !== "succeeded") return 2;
  return rep.test_verdict === "pass" ? 0 : rep.test_verdict === "fail" ? 1 : 2;
}

// Resumes every pending run of this worktree (or one shard): waits if it is
// still running, then reports. Exit code is the worst one (2 over 1 over 0).
async function cmdCollect(opts) {
  const targets = opts.all ? allStates() : [[shardName(opts.shard), statePath(opts.shard)]];
  const names = ["pass", "fail", "blocked"];
  const pending = targets.filter(([, p]) => existsSync(p) && JSON.parse(readFileSync(p, "utf8")).pending);
  if (pending.length === 0) {
    console.log("nothing to collect");
    return 0;
  }
  const codes = await Promise.all(pending.map(async ([shard, p]) => {
    const state = JSON.parse(readFileSync(p, "utf8"));
    console.log(`[${shard || "default"}] collecting ${state.pending.runId} (${state.pending.sha})`);
    const code = await finishPending(state, shard, opts.timeout).catch((e) => {
      console.error(`[${shard || "default"}] ${e.message}`);
      return 2;
    });
    console.log(`[${shard || "default"}] ${names[code] ?? "blocked"} -> ${state.pending?.out ?? state.last?.out}`);
    return code;
  }));
  return codes.includes(2) ? 2 : codes.includes(1) ? 1 : 0;
}

async function cmdStatus() {
  const states = allStates();
  if (states.length === 0) {
    console.log("no runner for this worktree");
    return 0;
  }
  for (const [, p] of states) {
    const state = JSON.parse(readFileSync(p, "utf8"));
    const a = await api("GET", `/agents/${state.agentId}`).catch((e) => ({ status: `gone (${e.status})` }));
    console.log(JSON.stringify({ ...state, status: a.status, latestRunId: a.latestRunId,
      costCents: await costCents(state.agentId) }, null, 2));
  }
  return 0;
}

async function closeOne(shard, laneOpt) {
  const state = loadState(shard);
  if (state?.agentId) {
    await api("DELETE", `/agents/${state.agentId}`).catch((e) => { if (e.status !== 404) throw e; });
    console.log(`deleted ${state.agentId}${shard ? ` (shard ${shard})` : ""}`);
  }
  const lane = laneOpt ? (shard ? `${laneOpt}-${shard}` : laneOpt) : state?.lane;
  if (lane) {
    const specs = git("ls-remote", REMOTE, `refs/test-specs/${lane}/*`)
      .split("\n").map((l) => l.split(/\s+/)[1]).filter(Boolean);
    if (specs.length) git("push", "-q", REMOTE, ...specs.map((r) => `:${r}`));
    const logs = git("ls-remote", LOG_REPO_URL, `${LOG_PREFIX}/${lane}/*`)
      .split("\n").map((l) => l.split(/\s+/)[1]).filter(Boolean);
    if (logs.length) git("push", "-q", LOG_REPO_URL, ...logs.map((r) => `:${r}`));
    console.log(`deleted ${specs.length} spec refs (engram) and ${logs.length} results refs (log repo) for ${lane}`);
  }
  if (existsSync(statePath(shard))) rmSync(statePath(shard));
}

async function cmdClose(opts) {
  const shards = opts.all ? allStates().map(([s]) => s) : [shardName(opts.shard)];
  if (shards.length === 0) shards.push("");
  for (const shard of shards) await closeOne(shard, opts.lane);
  return 0;
}

// Runs one shard per spec file in parallel, each on its own agent and VM, then
// writes a summary. The exit code is the worst shard's (2 over 1 over 0).
async function cmdSuite(opts) {
  if (!opts.specs) usage("suite needs --specs a.txt,b.txt");
  const specs = opts.specs.split(",").map((x) => x.trim()).filter(Boolean);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const sha = git("rev-parse", "--short=8", "HEAD");
  const outDir = resolve(opts["out-dir"] || join("reports", laneSlug({ lane: opts.lane }, branch)));
  const shards = specs.map((spec) => ({
    spec,
    shard: basename(spec).replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 30),
  }));
  if (new Set(shards.map((x) => x.shard)).size !== shards.length) usage("spec file names must give distinct shard names");
  const names = ["pass", "fail", "blocked"];
  const results = await Promise.all(shards.map(({ spec, shard }) => new Promise((done) => {
    const out = join(outDir, `cloud-suite-${sha}-${shard}.md`);
    const args = [process.argv[1], "test", "--spec", spec, "--shard", shard, "--out", out];
    for (const k of ["lane", "timeout", "model", "detach"]) if (opts[k]) args.push(`--${k}`, opts[k]);
    const started = Date.now();
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => process.stdout.write(`[${shard}] ${d}`));
    child.stderr.on("data", (d) => process.stderr.write(`[${shard}] ${d}`));
    child.on("close", (code) => done({ shard, spec, out, code: code ?? 2, seconds: Math.round((Date.now() - started) / 1000) }));
  })));
  if (opts.detach) {
    const failed = results.filter((r) => r.code !== 0);
    console.log(`suite: ${results.length - failed.length} shard(s) started detached; collect later with: node ${process.argv[1]} collect --all yes`);
    return failed.length ? 2 : 0;
  }
  const worst = results.some((r) => r.code !== 0 && r.code !== 1) ? 2 : results.some((r) => r.code === 1) ? 1 : 0;
  const rows = results.map((r) =>
    `| ${r.shard} | \`${r.spec}\` | ${names[r.code] ?? "blocked"} (exit ${r.code}) | ${r.seconds} | [report](${basename(r.out)}) |`).join("\n");
  const summary = join(outDir, `cloud-suite-${sha}.md`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(summary, `# Cloud suite: ${branch} @ ${sha}

- suite_verdict: **${names[worst]}** (worst shard)
- shards: ${results.length}, run in parallel

| shard | spec | verdict | seconds | report |
| --- | --- | --- | --- | --- |
${rows}
`);
  console.log(`suite: ${names[worst]}; summary ${summary}`);
  return worst;
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
const handlers = { ensure: cmdEnsure, test: cmdTest, suite: cmdSuite, collect: cmdCollect, status: cmdStatus, close: cmdClose };
if (!handlers[cmd]) usage(cmd ? `unknown command ${cmd}` : undefined);
handlers[cmd](opts).then((code) => process.exit(code), (e) => {
  console.error(`cloud-runner: ${e.message}`);
  process.exit(2);
});
