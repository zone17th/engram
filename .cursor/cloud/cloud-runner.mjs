#!/usr/bin/env node
// Drives one Cursor cloud agent per git worktree of zone17th/engram as a test
// runner, through the Cloud Agents API v1. Ported from the uniwork runner
// (same commands, state, pending/collect and exit codes).
//
// The worktree pushes its branch; this script publishes the spec as
// refs/test-specs/<lane>/<sha> on engram (commands only, deleted after the
// round), asks the runner VM to check out that exact commit, run the listed
// commands and answer with one JSON block. engram is PUBLIC, so the VM pushes
// its logs only to an allowlisted PRIVATE log repository as
// refs/test-results/engram/<lane>/<sha>; this script validates the repo and
// ref, fetches the logs, writes a Markdown report and deletes the ref.
//
//   node cloud-runner.mjs ensure  [--repo engram|url] [--branch b] [--model m]
//   node cloud-runner.mjs test    --spec file [--lane slug] [--shard name] [--out report.md] [--timeout s] [--detach yes]
//   node cloud-runner.mjs suite   --specs a.txt,b.txt,... [--lane slug] [--out-dir dir] [--timeout s] [--detach yes]
//   node cloud-runner.mjs collect [--shard name | --all yes] [--timeout s]
//   node cloud-runner.mjs status
//   node cloud-runner.mjs close   [--lane slug] [--shard name | --all yes]
//
// Exit codes: 0 pass, 1 tests failed, 2 blocked or runner error.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_API = process.env.CLOUD_RUNNER_API_URL || "https://api.cursor.com/v1";
const API = /^https:\/\/api\.cursor\.com\/v1\/?$|^http:\/\/127\.0\.0\.1:\d+(?:\/v1)?\/?$/.test(RAW_API)
  ? RAW_API.replace(/\/+$/, "")
  : "https://api.cursor.com/v1";
const REPO_URL = "https://github.com/zone17th/engram";
const REPOS = {
  engram: { url: REPO_URL, profile: "engram" },
};
const DEFAULT_REPO = "engram";

// Fixed allowlist of PRIVATE log repositories (advisor-dec-P06-002). Environment
// overrides may select between them, never add an unapproved or public URL.
const ALLOWED_LOG_REPOS = [
  "https://github.com/zone17th/engram-test-logs",
  "https://github.com/UNIAI-TEAM/uniwork",
];
const RAW_LOG_REPO_URL = process.env.CLOUD_RUNNER_LOG_REPO || ALLOWED_LOG_REPOS[0];
const RAW_BOOT_REPO_URL = process.env.CLOUD_RUNNER_BOOT_REPO || ALLOWED_LOG_REPOS[1];
const BOOT_BRANCH = process.env.CLOUD_RUNNER_BOOT_BRANCH || "test/cursor-cloud-env";
const LOG_PREFIX = "refs/test-results/engram";
// The engram branch whose .cursor/cloud the VM runs; develop once merged.
const ENV_BRANCH = process.env.CLOUD_RUNNER_ENV_BRANCH || "phase06/cloudrun";
const DEFAULT_MODEL = "grok-4.6:effort=high,fast=false";
const POLL_MS = Number(process.env.CLOUD_RUNNER_POLL_MS || 20_000);

const normUrl = (u) => String(u ?? "").trim()
  .replace(/^https?:\/\/[^/\s:@]+(?::[^@\s/]*)?@/i, "https://")
  .replace(/^git@github\.com:/i, "https://github.com/")
  .replace(/\.git$/i, "")
  .replace(/\/+$/, "")
  .toLowerCase();

const ALLOWED_LOG_NORMS = new Set(ALLOWED_LOG_REPOS.map(normUrl));
const canonicalLogRepo = (u) => ALLOWED_LOG_REPOS.find((a) => normUrl(a) === normUrl(u)) || null;

function usage(msg) {
  if (msg) console.error(`cloud-runner: ${msg}`);
  console.error("usage: cloud-runner.mjs ensure|test|suite|collect|status|close [--repo engram|url] [--branch b] [--spec f] [--specs a,b] [--lane s] [--shard n] [--out f] [--out-dir d] [--model m] [--timeout s] [--all yes] [--detach yes]");
  process.exit(2);
}

const LOG_REPO_URL = canonicalLogRepo(RAW_LOG_REPO_URL);
if (!LOG_REPO_URL) {
  usage(`untrusted CLOUD_RUNNER_LOG_REPO ${RAW_LOG_REPO_URL.replace(/(\/\/[^/\s:@]*:)[^@\s]+@/g, "$1[REDACTED]@")}; allowed private repos: ${ALLOWED_LOG_REPOS.join(", ")}`);
}
const BOOT_REPO_URL = canonicalLogRepo(RAW_BOOT_REPO_URL);
if (!BOOT_REPO_URL) {
  usage(`untrusted CLOUD_RUNNER_BOOT_REPO ${RAW_BOOT_REPO_URL.replace(/(\/\/[^/\s:@]*:)[^@\s]+@/g, "$1[REDACTED]@")}; allowed private repos: ${ALLOWED_LOG_REPOS.join(", ")}`);
}

// POSIX single-quote shell escaping so dynamic values are never parsed as syntax.
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function validBranch(b, label = "branch") {
  const s = String(b ?? "");
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(s) || s.startsWith("-") || s.startsWith("/") || s.endsWith("/")
      || s.includes("..") || s.includes("//") || s.endsWith(".lock")) {
    usage(`invalid ${label}: ${s}`);
  }
  return s;
}

function validLane(l, label = "lane") {
  const s = String(l ?? "");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(s) || s.startsWith("-") || s.includes("..")) {
    usage(`invalid ${label}: ${s}`);
  }
  return s;
}

validBranch(ENV_BRANCH, "CLOUD_RUNNER_ENV_BRANCH");
validBranch(BOOT_BRANCH, "CLOUD_RUNNER_BOOT_BRANCH");

function modelSpec(text) {
  const [id, params = ""] = text.split(":");
  const list = params.split(",").filter(Boolean).map((p) => {
    const [pid, value] = p.split("=");
    return { id: pid, value };
  });
  return list.length ? { id, params: list } : { id };
}

// Refreshes the runner scripts from ENV_BRANCH into ~/.engram-cloud (nothing
// lands in the tested checkout), then hands the whole round to run-tests.sh.
const ENV_GIT = "~/.engram-cloud/env.git";
const REFRESH = [
  `mkdir -p ~/.engram-cloud && git init -q --bare ${ENV_GIT}`,
  `git -C ${ENV_GIT} fetch -q --depth 1 ${shQuote(REPO_URL)} ${shQuote(ENV_BRANCH)}`,
  `git -C ${ENV_GIT} archive FETCH_HEAD .cursor/cloud | tar -x -C ~/.engram-cloud`,
].join(" && ");

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith("--") || i + 1 >= rest.length) usage(`unexpected argument ${a}`);
    opts[a.slice(2)] = rest[i + 1];
    i += 1;
  }
  return { cmd, opts };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function originUrl() {
  try { return git("remote", "get-url", "origin"); } catch { return ""; }
}

function repoInfo(name) {
  const { url, profile } = REPOS[name];
  const origin = originUrl();
  return { name, url, profile, remote: origin && normUrl(origin) === normUrl(url) ? "origin" : url };
}

function resolveRepo(opts) {
  const byUrl = (u) => Object.keys(REPOS).find((n) => normUrl(REPOS[n].url) === normUrl(u));
  if (!opts.repo) return repoInfo(byUrl(originUrl()) || DEFAULT_REPO);
  const name = REPOS[opts.repo] ? opts.repo : byUrl(opts.repo);
  if (!name) usage(`unknown repo ${opts.repo}; known: ${Object.keys(REPOS).join(", ")} or their URLs`);
  return repoInfo(name);
}

// CURSOR_API_KEY from the environment, else from cloud.env beside this script
// (gitignored, mode 600; `CURSOR_API_KEY=...` line), else the Windows user scope.
function apiKey() {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  const envFile = join(HERE, "cloud.env");
  if (existsSync(envFile)) {
    const m = /^\s*CURSOR_API_KEY\s*=\s*"?([^"\s#]+)"?\s*$/m.exec(readFileSync(envFile, "utf8"));
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
  if (shard && (!/^[A-Za-z0-9._-]{1,30}$/.test(shard) || shard.startsWith("-") || shard.includes(".."))) {
    usage(`bad shard name ${shard}`);
  }
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
  const base = opts.lane
    ? validLane(opts.lane, "lane")
    : branch.replace(/^[a-z]+\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "lane";
  const slug = opts.shard ? `${base}-${shardName(opts.shard)}` : base;
  return validLane(slug, "lane");
}

function trackLane(state, lane) {
  const set = new Set([...(state?.lanes || []), state?.lane, state?.pending?.lane, lane].filter(Boolean));
  return [...set];
}

function trackLogRepos(state, ...extra) {
  const candidates = [
    ...(state?.logRepos || []),
    LOG_REPO_URL,
    ...(state?.via === "clone" ? [BOOT_REPO_URL] : []),
    ...extra,
  ].filter(Boolean);
  const byNorm = new Map();
  for (const u of candidates) {
    const canon = canonicalLogRepo(u);
    if (canon) {
      const n = normUrl(canon);
      if (!byNorm.has(n)) byNorm.set(n, canon);
    }
  }
  return [...byNorm.values()];
}

async function waitRun(agentId, runId, timeoutS, startedAt = Date.now()) {
  const deadline = startedAt + timeoutS * 1000;
  for (;;) {
    let run;
    try {
      run = await api("GET", `/agents/${agentId}/runs/${runId}`);
    } catch (e) {
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

async function createAgent(branch, model, promptFor) {
  validBranch(branch);
  const create = (repo, via) => api("POST", "/agents", {
    name: `runner engram ${branch}`.slice(0, 80),
    prompt: { text: promptFor(via) },
    model: modelSpec(model),
    repos: [repo],
    env: { type: "cloud" },
    autoCreatePR: false,
  });
  let r;
  let via = "direct";
  try {
    r = await create({ url: REPO.url, startingRef: branch }, via);
  } catch (e) {
    if (e.status !== 400 || !/verify|access to repository/i.test(e.message)) throw e;
    console.error(`cloud-runner: Cursor SCM cannot open ${REPO.url}; booting on private boot repo and cloning engram`);
    via = "clone";
    r = await create({ url: BOOT_REPO_URL, startingRef: BOOT_BRANCH }, via);
  }
  return { agentId: r.agent.id, runId: r.run.id, via };
}

async function sendRun(agentId, prompt, deadline = Infinity) {
  for (;;) {
    try {
      const r = await api("POST", `/agents/${agentId}/runs`, { prompt: { text: prompt } });
      return (r.run ?? r).id;
    } catch (e) {
      if (e.status !== 409) throw e;
      if (Date.now() + POLL_MS > deadline) {
        const err = new Error(`agent ${agentId} remained busy (HTTP 409) past timeout`);
        err.status = 409;
        throw err;
      }
      await sleep(POLL_MS);
    }
  }
}

function oneCommandPrompt(argPairs, via = "direct") {
  const fullPairs = [...argPairs, ["--profile", REPO.profile]];
  if (via === "clone") fullPairs.push(["--repo-url", REPO.url]);
  fullPairs.push(["--log-repo", LOG_REPO_URL]);
  const quotedArgs = fullPairs.flat().map((a) => shQuote(a)).join(" ");
  return `You are a test runner. Run exactly one command, from the repository root,
and wait for it to finish (up to 45 minutes on a new VM). Do not run anything
else, do not edit, commit or push any file, do not open a PR, and do not look
into failures:

    ${REFRESH} && bash ~/.engram-cloud/.cursor/cloud/run-tests.sh ${quotedArgs}

The last line it prints is a JSON object. Reply with only that object, unchanged,
inside one \`\`\`json fence. If it printed no JSON, reply inside the fence with
{"stage_outcome": "failed", "test_verdict": "blocked", "notes": "<its last 3 output lines>"}.`;
}

function ensurePrompt(branch, via) {
  validBranch(branch);
  return oneCommandPrompt([["--branch", branch], ["--provision-only"]], via);
}

function publishSpec(lane, sha, commands) {
  validLane(lane);
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) usage(`invalid sha: ${sha}`);
  const text = `${commands.join("\n")}\n`;
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["mktree"], { input: `100644 blob ${blob}\tspec.txt\n`, encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["commit-tree", tree, "-m", `spec ${lane} ${sha}`],
    { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "runner", GIT_AUTHOR_EMAIL: "runner@local",
      GIT_COMMITTER_NAME: "runner", GIT_COMMITTER_EMAIL: "runner@local" } }).trim();
  const ref = `refs/test-specs/${lane}/${sha}`;
  git("push", "-q", "-f", REPO.remote, `${commit}:${ref}`);
  return { ref, sha256: createHash("sha256").update(text).digest("hex") };
}

function testPrompt({ branch, sha, lane, spec }, via) {
  validBranch(branch);
  validLane(lane);
  if (!/^refs\/test-specs\/[A-Za-z0-9._-]+\/[0-9a-f]{7,40}$/i.test(spec.ref)) usage(`invalid spec ref: ${spec.ref}`);
  if (!/^[0-9a-f]{64}$/i.test(spec.sha256)) usage(`invalid spec sha256: ${spec.sha256}`);
  return oneCommandPrompt([
    ["--branch", branch],
    ["--sha", sha],
    ["--lane", lane],
    ["--spec-ref", spec.ref],
    ["--spec-sha256", spec.sha256],
  ], via);
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

function scrubText(text) {
  return String(text ?? "")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|key_[A-Za-z0-9]{20,})\b/g, "[REDACTED]")
    .replace(/(\/\/[^/\s:@]*:)[^@\s]+@/g, "$1[REDACTED]@");
}

function logsPath(out) {
  return /\.md$/i.test(out) ? out.replace(/\.md$/i, ".logs") : `${out}.logs`;
}

function logsDigest(dir) {
  try {
    if (!dir || !existsSync(dir) || !lstatSync(dir).isDirectory()) return null;
    const entries = readdirSync(dir).sort();
    if (entries.length === 0) return null;
    const h = createHash("sha256");
    let count = 0;
    for (const name of entries) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (!st.isFile() || st.isSymbolicLink()) return null;
      h.update(`${name}\0`);
      h.update(createHash("sha256").update(readFileSync(p)).digest("hex"));
      h.update("\n");
      count += 1;
    }
    return count > 0 ? h.digest("hex") : null;
  } catch {
    return null;
  }
}

function writeReport(out, meta, rep, rawResult) {
  const rows = (rep?.ran ?? []).map((r) => `| \`${scrubText(r.cmd)}\` | ${scrubText(r.result)} | ${r.duration_s} |`).join("\n");
  const fails = (rep?.failures ?? []).map((f) => `- \`${scrubText(f.test)}\` ${scrubText(f.file ?? "")}: ${scrubText(f.msg)}`).join("\n");
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

${(rep?.not_run ?? []).map((n) => `- ${scrubText(n)}`).join("\n") || "Nothing."}

## Notes

${scrubText(rep?.notes) || "None."}

## Raw report

\`\`\`json
${scrubText(rep ? JSON.stringify(rep, null, 2) : String(rawResult ?? "").slice(0, 4000))}
\`\`\`
`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
}

// Fetches the results commit from an allowlisted private log repository into a
// fresh directory (replacing any prior logs atomically) and removes the local
// ref. Remote ref deletion is deferred until the report and state are saved.
function fetchLogs(ref, dir, remote, expectedRef) {
  if (!ref || ref !== expectedRef || !ALLOWED_LOG_NORMS.has(normUrl(remote))) {
    console.error(`cloud-runner: refusing untrusted log ref/repo (${ref} vs ${expectedRef} on ${remote})`);
    return null;
  }
  const tmpDir = `${dir}.tmp-${process.pid}-${Date.now()}`;
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        git("fetch", "-q", remote, `${ref}:${ref}`);
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        execFileSync(process.execPath, ["-e", `setTimeout(() => {}, ${attempt * 3000})`]);
      }
    }
    const files = git("ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean);
    if (files.length === 0) throw new Error("results commit has no log files");
    mkdirSync(tmpDir, { recursive: true });
    for (const name of files) {
      const file = join(tmpDir, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, execFileSync("git", ["show", `${ref}:${name}`], { maxBuffer: 1 << 30 }));
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmpDir, dir);
    git("update-ref", "-d", ref);
    return dir;
  } catch (e) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { git("update-ref", "-d", ref); } catch { /* ignore */ }
    console.error(`cloud-runner: could not fetch logs from ${ref}: ${e.message}`);
    return null;
  }
}

async function cmdEnsure(opts) {
  const branch = validBranch(opts.branch || git("rev-parse", "--abbrev-ref", "HEAD"));
  const timeoutS = Number(opts.timeout || 1800);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutS * 1000;
  let state = loadState(opts.shard);
  const alive = await agentAlive(state);
  if (alive && state.provisioned === true && !state.pending && !state.provisionRunId) {
    console.log(`runner ready: ${state.agentId} (${state.branch})`);
    return 0;
  }
  const model = opts.model || DEFAULT_MODEL;
  const lane = laneSlug(opts, branch);
  let agentId;
  let runId;
  let via = state?.via ?? "direct";
  if (alive) {
    agentId = state.agentId;
    runId = state.provisionRunId || await sendRun(agentId, ensurePrompt(branch, via), deadline);
    state = { ...state, branch, lane, lanes: trackLane(state, lane), logRepos: trackLogRepos(state), provisioned: false, provisionRunId: runId };
  } else {
    ({ agentId, runId, via } = await createAgent(branch, model, (v) => ensurePrompt(branch, v)));
    state = {
      agentId, via, branch, model, lane, lanes: trackLane(state, lane),
      logRepos: trackLogRepos({ ...state, via }), shard: shardName(opts.shard), provisioned: false, provisionRunId: runId,
      createdAt: new Date().toISOString(),
    };
  }
  saveState(state, opts.shard);
  console.log(`runner ${agentId}; provisioning (about 10 min)`);
  const run = await waitRun(agentId, runId, timeoutS, startedAt);
  const rep = extractReport(run.result);
  const ok = run.status === "FINISHED" && rep?.stage_outcome === "succeeded"
    && /^[0-9a-f]{40}$/i.test(String(rep?.sha ?? ""));
  delete state.provisionRunId;
  state.provisioned = Boolean(ok);
  saveState(state, opts.shard);
  console.log(`provision: ${run.status} ${rep?.stage_outcome ?? "no report"} ${rep?.notes ?? ""}`);
  return ok ? 0 : 2;
}

async function cmdTest(opts) {
  if (!opts.spec) usage("test needs --spec");
  const commands = readFileSync(opts.spec === "-" ? 0 : opts.spec, "utf8")
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (commands.length === 0) usage("spec has no commands");
  const branch = validBranch(git("rev-parse", "--abbrev-ref", "HEAD"));
  const sha = git("rev-parse", "HEAD").toLowerCase();
  const remote = (git("ls-remote", REPO.remote, `refs/heads/${branch}`).split(/\s+/)[0] ?? "").toLowerCase();
  if (remote !== sha) {
    usage(`engram:${branch} is not at HEAD ${sha}; push the branch first`);
  }
  let state = loadState(opts.shard);
  if (state?.pending) {
    usage(`${shardName(opts.shard) || "default runner"} has an uncollected run ${state.pending.runId} (${state.pending.sha}); run collect first`);
  }
  const timeoutS = Number(opts.timeout || 3600);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutS * 1000;
  const lane = laneSlug(opts, branch);
  // Resolve liveness and usage before publishing the spec ref so a lookup error
  // never leaves an unreferenced spec ref on the public repository.
  const alive = await agentAlive(state);
  const before = alive ? await costCents(state.agentId) : 0;
  const spec = publishSpec(lane, sha, commands);
  const promptFor = (via) => testPrompt({ branch, sha, lane, spec }, via);
  let agentId;
  let runId;
  let via = state?.via ?? "direct";
  try {
    if (alive) {
      agentId = state.agentId;
      runId = await sendRun(agentId, promptFor(via), deadline);
    } else {
      ({ agentId, runId, via } = await createAgent(branch, opts.model || DEFAULT_MODEL, promptFor));
    }
    const lanes = trackLane(state, lane);
    const logRepos = trackLogRepos({ ...state, via });
    if (!alive) {
      state = {
        agentId, via, branch, model: opts.model || DEFAULT_MODEL,
        lane, lanes, logRepos, shard: shardName(opts.shard), provisioned: false,
        createdAt: new Date().toISOString(),
      };
    } else {
      state.lane = lane;
      state.lanes = lanes;
      state.logRepos = logRepos;
    }
    state.pending = {
      runId, sha, branch, lane, specRef: spec.ref,
      expectedCount: commands.length, expectedCommands: commands.map(scrubText), specSha256: spec.sha256,
      costBefore: before,
      out: resolve(opts.out || join("reports", lane, `cloud-test-${sha.slice(0, 8)}.md`)),
      timeoutS, startedAt,
    };
    saveState(state, opts.shard);
  } catch (e) {
    try { git("push", "-q", REPO.remote, `:${spec.ref}`); } catch { /* best effort */ }
    throw e;
  }
  console.log(`run ${runId} on ${agentId} for ${sha}`);
  if (opts.detach) {
    console.log(`detached; collect later with: node ${process.argv[1]} collect${opts.shard ? ` --shard ${opts.shard}` : ""}`);
    return 0;
  }
  return finishPending(state, opts.shard);
}

// Waits for the state's pending run, validates the report and log repository,
// pulls the logs, writes the report and clears `pending`. If log retrieval
// fails transiently after a finished run, `pending` is retained so `collect`
// can retry without re-running the VM.
async function finishPending(state, shard, timeoutOverride) {
  const p = state.pending;
  if (!/^[0-9a-f]{40}$/i.test(String(p?.sha ?? "")) || !Array.isArray(p?.expectedCommands) || p.expectedCommands.length === 0) {
    console.error(`cloud-runner: legacy pending state for ${p?.runId ?? "unknown"} (sha=${p?.sha ?? "none"}) lacks full 40-char SHA or expectedCommands manifest; preserving pending state and existing report without destructive finalization. Drain with 'node ${process.argv[1]} close --all yes' and re-run 'test' under full-SHA binding.`);
    return 2;
  }
  let runStatus = p.runStatus;
  let durationMs = p.durationMs;
  let rawResult = p.rawResult;
  let after = p.costAfter;
  if (!p.runFinished) {
    const run = await waitRun(state.agentId, p.runId, Number(timeoutOverride || p.timeoutS), timeoutOverride ? Date.now() : p.startedAt);
    runStatus = run.status;
    durationMs = run.durationMs;
    rawResult = run.result;
    after = await costCents(state.agentId);
    try { git("push", "-q", REPO.remote, `:${p.specRef}`); } catch { /* best effort */ }
    p.runFinished = true;
    p.runStatus = runStatus;
    p.durationMs = durationMs;
    p.rawResult = rawResult;
    p.costAfter = after;
    saveState(state, shard);
  }
  const rep = extractReport(rawResult);
  const shaMatch = Boolean(rep && /^[0-9a-f]{40}$/i.test(String(p.sha ?? ""))
    && String(rep.sha ?? "").toLowerCase() === String(p.sha ?? "").toLowerCase());
  const countMatch = Boolean(rep && Array.isArray(rep.ran) && rep.ran.length > 0
    && Array.isArray(p.expectedCommands) && p.expectedCommands.length > 0
    && rep.ran.length === p.expectedCommands.length
    && rep.ran.every((r, i) => scrubText(r?.cmd) === scrubText(p.expectedCommands[i])));
  const stageOk = Boolean(rep && rep.stage_outcome === "succeeded" && (rep.test_verdict === "pass" || rep.test_verdict === "fail"));
  const logRemote = rep?.log_repo ? canonicalLogRepo(rep.log_repo) : null;
  const expectedRef = /^[0-9a-f]{40}$/i.test(String(p.sha ?? "")) ? `${LOG_PREFIX}/${p.lane}/${String(p.sha).toLowerCase()}` : null;
  const refMatch = Boolean(expectedRef && rep?.log_ref === expectedRef);

  let logsDir = p.logsDir && p.logsDigest && logsDigest(p.logsDir) === p.logsDigest ? p.logsDir : null;
  let retryableLogFailure = false;
  if (runStatus === "FINISHED" && shaMatch && countMatch && stageOk && logRemote && refMatch && !logsDir) {
    const fetchedDir = fetchLogs(expectedRef, logsPath(p.out), logRemote, expectedRef);
    const digest = fetchedDir ? logsDigest(fetchedDir) : null;
    if (fetchedDir && digest) {
      logsDir = fetchedDir;
      p.logsDir = fetchedDir;
      p.logsDigest = digest;
      state.logRepos = trackLogRepos(state, logRemote);
      saveState(state, shard);
    } else {
      retryableLogFailure = true;
    }
  }

  const valid = Boolean(runStatus === "FINISHED" && shaMatch && countMatch && stageOk && logRemote && refMatch && logsDir);
  const problems = [];
  if (runStatus !== "FINISHED") problems.push(`run ${runStatus}`);
  if (!rep) problems.push("no JSON report");
  else {
    if (!shaMatch) problems.push(`sha mismatch (${rep.sha ?? "none"} vs ${p.sha})`);
    if (!countMatch) problems.push(`ran commands do not match submitted spec (${Array.isArray(rep.ran) ? rep.ran.length : 0} vs ${p.expectedCount ?? "?"})`);
    if (!stageOk) problems.push(`stage_outcome=${rep.stage_outcome} verdict=${rep.test_verdict}`);
    if (!logRemote) problems.push(`untrusted or missing log_repo (${rep.log_repo ?? "none"})`);
    if (!refMatch) problems.push(`unexpected log_ref (${rep.log_ref ?? "none"}, wanted ${expectedRef ?? "none"})`);
    if (retryableLogFailure) problems.push("log fetch failed (pending retained for collect retry)");
  }

  writeReport(p.out, {
    lane: p.lane, sha: p.sha, branch: p.branch, agentId: state.agentId, runId: p.runId, runStatus,
    durationMs, costCents: after == null || p.costBefore == null ? null : after - p.costBefore, logsDir,
  }, valid ? rep : {
    ...(rep ?? {}),
    stage_outcome: "failed",
    test_verdict: "blocked",
    notes: `${problems.join("; ")}. ${rep?.notes ?? ""}`.trim(),
  }, rawResult);
  console.log(`report: ${p.out}`);

  if (retryableLogFailure) {
    saveState(state, shard);
    return 2;
  }
  if (valid) state.provisioned = true;
  if (logRemote) state.logRepos = trackLogRepos(state, logRemote);
  state.last = { runId: p.runId, sha: p.sha, out: p.out, runStatus, verdict: valid ? rep.test_verdict : "blocked" };
  delete state.pending;
  saveState(state, shard);
  if (valid && logRemote && expectedRef) {
    try { git("push", "-q", logRemote, `:${expectedRef}`); } catch { /* close retries */ }
  }
  if (!valid) return 2;
  return rep.test_verdict === "pass" ? 0 : rep.test_verdict === "fail" ? 1 : 2;
}

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
    console.log(scrubText(JSON.stringify({ ...state, status: a.status, latestRunId: a.latestRunId,
      costCents: await costCents(state.agentId) }, null, 2)));
  }
  return 0;
}

async function closeOne(shard, laneOpt) {
  const state = loadState(shard);
  const errors = [];
  if (state?.agentId) {
    try {
      await api("DELETE", `/agents/${state.agentId}`);
      console.log(`deleted ${state.agentId}${shard ? ` (shard ${shard})` : ""}`);
      delete state.agentId;
    } catch (e) {
      if (e.status === 404) {
        delete state.agentId;
      } else {
        errors.push(`delete agent ${state.agentId}: ${e.message}`);
      }
    }
  }
  const explicitLane = laneOpt ? validLane(shard ? `${laneOpt}-${shard}` : laneOpt) : null;
  const lanes = [...new Set([explicitLane, state?.lane, state?.pending?.lane, ...(state?.lanes || [])].filter(Boolean))];
  const remainingLanes = [];
  for (const lane of lanes) {
    validLane(lane);
    let laneFailed = false;
    try {
      const specs = git("ls-remote", REPO.remote, `refs/test-specs/${lane}/*`)
        .split("\n").map((l) => l.split(/\s+/)[1]).filter(Boolean);
      if (specs.length) git("push", "-q", REPO.remote, ...specs.map((r) => `:${r}`));
      console.log(`deleted ${specs.length} spec refs in engram for ${lane}`);
    } catch (e) {
      laneFailed = true;
      errors.push(`spec refs (${lane}): ${e.message}`);
    }
    const reposToClean = trackLogRepos(state);
    for (const repo of reposToClean) {
      try {
        const logs = git("ls-remote", repo, `${LOG_PREFIX}/${lane}/*`)
          .split("\n").map((l) => l.split(/\s+/)[1]).filter(Boolean);
        if (logs.length) git("push", "-q", repo, ...logs.map((r) => `:${r}`));
        console.log(`deleted ${logs.length} results refs in ${repo} for ${lane}`);
      } catch (e) {
        laneFailed = true;
        errors.push(`log refs (${lane} in ${repo}): ${e.message}`);
      }
    }
    if (laneFailed) remainingLanes.push(lane);
  }
  if (errors.length === 0) {
    if (existsSync(statePath(shard))) rmSync(statePath(shard));
    return true;
  }
  if (state) {
    state.lanes = remainingLanes;
    saveState(state, shard);
  }
  for (const msg of errors) console.error(`cloud-runner close: ${msg}`);
  return false;
}

async function cmdClose(opts) {
  const shards = opts.all ? allStates().map(([s]) => s) : [shardName(opts.shard)];
  if (shards.length === 0) shards.push("");
  let allOk = true;
  for (const shard of shards) {
    const ok = await closeOne(shard, opts.lane);
    if (!ok) allOk = false;
  }
  return allOk ? 0 : 2;
}

async function cmdSuite(opts) {
  if (!opts.specs) usage("suite needs --specs a.txt,b.txt");
  const specs = opts.specs.split(",").map((x) => x.trim()).filter(Boolean);
  if (specs.length === 0) usage("suite needs at least one spec");
  const branch = validBranch(git("rev-parse", "--abbrev-ref", "HEAD"));
  const sha = git("rev-parse", "HEAD").toLowerCase().slice(0, 8);
  const outDir = resolve(opts["out-dir"] || join("reports", laneSlug({ lane: opts.lane }, branch)));
  const shards = specs.map((spec) => ({
    spec,
    shard: shardName(basename(spec).replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30)),
  }));
  if (shards.some((x) => !x.shard) || new Set(shards.map((x) => x.shard)).size !== shards.length) {
    usage("spec file names must give distinct non-empty shard names");
  }
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
const REPO = resolveRepo(opts);
const handlers = { ensure: cmdEnsure, test: cmdTest, suite: cmdSuite, collect: cmdCollect, status: cmdCollect && cmdStatus, close: cmdClose };
if (!handlers[cmd]) usage(cmd ? `unknown command ${cmd}` : undefined);
handlers[cmd](opts).then((code) => process.exit(code), (e) => {
  console.error(`cloud-runner: ${e.message}`);
  process.exit(2);
});
