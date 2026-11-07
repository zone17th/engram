import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_TESTS_SH = join(HERE, "run-tests.sh");
const START_ENGRAM_SH = join(HERE, "start-engram.sh");
const CLOUD_RUNNER_MJS = join(HERE, "cloud-runner.mjs");
const SPECS_DIR = join(HERE, "specs");

function setupVmSandbox(specLines, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "engram-runner-test-"));
  const home = join(root, "home");
  const cloudDir = join(home, ".engram-cloud", ".cursor", "cloud");
  const stateDir = join(home, ".engram-cloud", "state");
  const repoDir = join(root, "repo");
  const binDir = join(root, "bin");
  const pushLog = join(root, "pushes.log");
  const eventsLog = join(root, "events.log");
  mkdirSync(cloudDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(repoDir, "apps", "api"), { recursive: true });
  mkdirSync(join(repoDir, "packages", "crypto-vectors"), { recursive: true });
  mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
  mkdirSync(join(repoDir, "infra"), { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(join(cloudDir, "run-tests.sh"), readFileSync(RUN_TESTS_SH));
  for (const s of ["provision-engram.sh", "install-engram.sh", "start-engram.sh"]) {
    writeFileSync(join(cloudDir, s), `#!/usr/bin/env bash\necho "${s}" >> "${eventsLog}"\nexit 0\n`, { mode: 0o755 });
  }
  writeFileSync(join(binDir, "pnpm"), `#!/usr/bin/env bash\necho "pnpm $*" >> "${eventsLog}"\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join( repoDir, "package.json"), "{}\n");
  writeFileSync(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
  writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repoDir, "packages", "crypto-vectors", "package.json"), '{"name":"@engram/crypto-vectors"}\n');
  writeFileSync(join(repoDir, "apps", "api", "go.mod"), "module engram\ngo 1.26.0\n");
  writeFileSync(join(repoDir, "apps", "api", "go.sum"), "\n");
  writeFileSync(join(repoDir, ".github", "workflows", "ci.yml"), "go-version: '1.27.3'\n");
  writeFileSync(join(repoDir, "infra", "image-pins.env"), "NODE_IMAGE=node:22\n");

  execFileSync("git", ["init", "-q", "-b", "phase06/cloudrun"], { cwd: repoDir });
  execFileSync("git", ["add", "-A"], { cwd: repoDir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-qm", "init"], { cwd: repoDir });
  const fullSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim().toLowerCase();
  const sha = fullSha.slice(0, 8);

  const specText = `${specLines.join("\n")}\n`;
  const specFile = join(root, "spec.txt");
  writeFileSync(specFile, specText);
  const specSha = createHash("sha256").update(specText).digest("hex");

  const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const gitWrapper = join(binDir, "git");
  writeFileSync(gitWrapper, `#!/usr/bin/env bash
if [ "$1" = "fetch" ] && [[ "$*" == *"refs/test-specs/"* ]]; then exit 0; fi
if [ "$1" = "show" ] && [ "$2" = "FETCH_HEAD:spec.txt" ]; then cat "${specFile}"; exit 0; fi
if [ "$1" = "fetch" ] || [ "$1" = "reset" ] || [ "$1" = "clean" ]; then exit 0; fi
for a in "$@"; do
  if [ "$a" = "push" ]; then
    echo "git $*" >> "${pushLog}"
    exit 0
  fi
done
exec "${realGit}" "$@"
`, { mode: 0o755 });

  return {
    root,
    home,
    cloudDir,
    stateDir,
    repoDir,
    binDir,
    sha,
    fullSha,
    pushLog,
    eventsLog,
    run(args = [], runEnv = {}) {
      const env = {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH}`,
        ...extraEnv,
        ...runEnv,
      };
      const r = spawnSync("bash", [
        join(cloudDir, "run-tests.sh"),
        "--branch", "phase06/cloudrun",
        "--sha", sha,
        "--lane", "cloudrun",
        "--spec-ref", `refs/test-specs/cloudrun/${sha}`,
        "--spec-sha256", specSha,
        "--log-repo", "https://github.com/zone17th/engram-test-logs",
        ...args,
      ], { cwd: repoDir, env, encoding: "utf8" });
      const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
      const report = lines.length ? JSON.parse(lines.at(-1)) : null;
      const pushes = existsSync(pushLog) ? readFileSync(pushLog, "utf8").trim().split("\n").filter(Boolean) : [];
      const events = existsSync(eventsLog) ? readFileSync(eventsLog, "utf8").trim().split("\n").filter(Boolean) : [];
      return { status: r.status, report, pushes, events, stderr: r.stderr };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("standalone non-zero NAME_EXIT marker overrides shell exit 0 while embedded marker text passes (R1-20, R1-24)", () => {
  const sb = setupVmSandbox([
    'echo "fixture says EXPECTED_EXIT=7 inside JSON"',
    'false; rc=$?; printf "\\nRED_EXIT=%s\\n" "$rc"',
  ]);
  try {
    const { status, report, pushes } = sb.run();
    assert.equal(status, 0);
    assert.equal(report.stage_outcome, "succeeded");
    assert.equal(report.test_verdict, "fail");
    assert.equal(report.ran.length, 2);
    assert.equal(report.ran[0].result, "pass");
    assert.equal(report.ran[0].exit_code, 0);
    assert.equal(report.ran[1].result, "fail");
    assert.equal(report.ran[1].exit_code, 1);
    assert.equal(pushes.length, 1);
  } finally {
    sb.cleanup();
  }
});

test("rejects public engram repository as --log-repo with zero push attempts (R1-1)", () => {
  const sb = setupVmSandbox(["true; rc=$?; echo; echo OK_EXIT=$rc; exit $rc"]);
  try {
    const { status, report, pushes } = sb.run(["--log-repo", "https://github.com/zone17th/engram"]);
    assert.equal(status, 0);
    assert.equal(report.stage_outcome, "failed");
    assert.equal(report.test_verdict, "blocked");
    assert.equal(pushes.length, 0);
  } finally {
    sb.cleanup();
  }
});

test("redacts secret values and token-shaped strings from failure JSON and fails closed on scrubber failure (R1-2, R1-3)", () => {
  const canary = "CANARY_SECRET_VALUE_987654";
  const sb = setupVmSandbox(
    [`printf 'leak ${canary} and ghp_0123456789abcdef0123456789abcdef0123\\n'; exit 1`],
    { GH_TOKEN: canary },
  );
  try {
    const { report } = sb.run();
    const raw = JSON.stringify(report);
    assert.equal(report.test_verdict, "fail");
    assert.equal(raw.includes(canary), false);
    assert.equal(raw.includes("ghp_0123456789"), false);
    assert.equal(raw.includes("[REDACTED]"), true);
  } finally {
    sb.cleanup();
  }
});

test("spec files parse cleanly, full.txt matches grouped specs, and SIGTERM triggers single Compose teardown (R1-11, R3-7)", () => {
  const groups = ["go-unit.txt", "gen-nodiff.txt", "web-unit.txt", "go-race-integration.txt", "e2e.txt"];
  const cmdsOf = (file) => readFileSync(join(SPECS_DIR, file), "utf8")
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const grouped = groups.flatMap(cmdsOf);
  const full = cmdsOf("full.txt");
  assert.deepEqual(full, grouped);
  for (const cmd of full) {
    const r = spawnSync("bash", ["-n", "-c", cmd], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }

  // Exercise controlled SIGTERM on e2e-browser and compose-migrate lines
  const e2eBrowserLine = cmdsOf("e2e.txt")[1];
  const migrateLine = cmdsOf("gen-nodiff.txt")[3];
  for (const [line, triggerArg] of [[e2eBrowserLine, "run"], [migrateLine, "up"]]) {
    const d = mkdtempSync(join(tmpdir(), "engram-sigterm-"));
    try {
      mkdirSync(join(d, "infra"), { recursive: true });
      mkdirSync(join(d, "scripts"), { recursive: true });
      mkdirSync(join(d, "bin"), { recursive: true });
      writeFileSync(join(d, "infra", "image-pins.env"), "PLAYWRIGHT_IMAGE=fixture\n");
      writeFileSync(join(d, "scripts", "sanitize-e2e-artifacts.mjs"), "process.exit(0);\n");
      writeFileSync(join(d, "bin", "sudo"), "#!/usr/bin/env bash\nexec \"$@\"\n", { mode: 0o755 });
      writeFileSync(join(d, "bin", "curl"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(d, "bin", "docker"), `#!/usr/bin/env bash
echo "docker $*" >> "${join(d, "events.log")}"
if [[ "$*" == *"${triggerArg}"* ]]; then
  kill -TERM $PPID
  sleep 2
fi
exit 0
`, { mode: 0o755 });
      const r = spawnSync("bash", ["-c", line], {
        cwd: d,
        env: { ...process.env, PATH: `${join(d, "bin")}:${process.env.PATH}` },
        encoding: "utf8",
      });
      const events = readFileSync(join(d, "events.log"), "utf8");
      const downs = events.split("\n").filter((l) => l.includes("down --volumes --remove-orphans"));
      assert.equal(r.status, 143);
      assert.equal(downs.length, 1, `expected exactly 1 down on SIGTERM, got ${downs.length}:\n${events}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

test("host collect enforces command/SHA/checkpoint integrity, non-HTTP URL parity, and post-download recovery (R1-6, R1-9, R1-24, R2-1, R3-1, R3-2)", () => {
  const cmd = 'printf "%s\\n" "postgres://demo:fixture@localhost/db"; false; rc=$?; printf "\\nRED_EXIT=%s\\n" "$rc"';
  const sb = setupVmSandbox([cmd]);
  try {
    const { report } = sb.run();
    assert.equal(report.test_verdict, "fail");
    assert.equal(report.ran[0].cmd.includes("postgres://demo:[REDACTED]@localhost/db"), true);

    const hostRoot = mkdtempSync(join(tmpdir(), "engram-host-test-"));
    try {
      const wt = join(hostRoot, "wt");
      const logRepo = join(hostRoot, "logs.git");
      const bin = join(hostRoot, "bin");
      mkdirSync(wt, { recursive: true });
      mkdirSync(bin, { recursive: true });
      execFileSync("git", ["init", "-q", "--bare", logRepo]);
      execFileSync("git", ["init", "-q", "-b", "phase06/cloudrun"], { cwd: wt });
      writeFileSync(join(wt, "README.md"), "test\n");
      execFileSync("git", ["add", "README.md"], { cwd: wt });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-qm", "init"], { cwd: wt });

      const logCommitDir = join(hostRoot, "log-commit");
      mkdirSync(logCommitDir, { recursive: true });
      writeFileSync(join(logCommitDir, "a.log"), `EVIDENCE_FOR_A\nRED_EXIT=1\n`);
      execFileSync("git", ["init", "-q"], { cwd: logCommitDir });
      execFileSync("git", ["add", "a.log"], { cwd: logCommitDir });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-qm", "logs"], { cwd: logCommitDir });
      const ref = `refs/test-results/engram/cloudrun/${sb.sha}`;
      execFileSync("git", ["push", "-q", logRepo, `HEAD:${ref}`], { cwd: logCommitDir });

      const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      writeFileSync(join(bin, "git"), `#!/usr/bin/env bash
args=()
for a in "$@"; do
  if [ "$a" = "https://github.com/zone17th/engram-test-logs" ]; then
    args+=("${logRepo}")
  else
    args+=("$a")
  fi
done
exec "${realGit}" "\${args[@]}"
`, { mode: 0o755 });

      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CURSOR_API_KEY: "test_key" };
      const stateFile = join(wt, ".git", "cloud-runner.json");
      const outMd = join(hostRoot, "out.md");
      const scrubbedCmd = 'printf "%s\\n" "postgres://demo:[REDACTED]@localhost/db"; false; rc=$?; printf "\\nRED_EXIT=%s\\n" "$rc"';
      const makePending = (overrides = {}, repOverrides = {}) => ({
        agentId: "bc-test",
        via: "direct",
        branch: "phase06/cloudrun",
        lane: "cloudrun",
        lanes: ["cloudrun"],
        logRepos: ["https://github.com/zone17th/engram-test-logs"],
        pending: {
          runId: "run-1",
          sha: sb.sha,
          branch: "phase06/cloudrun",
          lane: "cloudrun",
          specRef: `refs/test-specs/cloudrun/${sb.sha}`,
          expectedCount: 1,
          expectedCommands: [scrubbedCmd],
          costBefore: 0,
          out: outMd,
          timeoutS: 60,
          startedAt: Date.now(),
          runFinished: true,
          runStatus: "FINISHED",
          durationMs: 1000,
          costAfter: 0,
          rawResult: "```json\n" + JSON.stringify({ ...report, ...repOverrides }) + "\n```",
          ...overrides,
        },
      });

      // 1) Legacy pending state without expectedCommands is rejected (R1-6)
      writeFileSync(stateFile, JSON.stringify(makePending({ expectedCommands: undefined })));
      let r = spawnSync(process.execPath, [CLOUD_RUNNER_MJS, "collect"], { cwd: wt, env, encoding: "utf8" });
      assert.equal(r.status, 2);

      // 2) Command mismatch rejected with exit 2 (R1-6)
      writeFileSync(stateFile, JSON.stringify(makePending({ expectedCommands: ["different command"] })));
      r = spawnSync(process.execPath, [CLOUD_RUNNER_MJS, "collect"], { cwd: wt, env, encoding: "utf8" });
      assert.equal(r.status, 2);

      // 3) 8th SHA char mismatch rejected with exit 2 before fetch (R1-9)
      const wrongSha = sb.sha.slice(0, 7) + (sb.sha[7] === "0" ? "1" : "0");
      writeFileSync(stateFile, JSON.stringify(makePending({}, { sha: wrongSha, log_ref: `refs/test-results/engram/cloudrun/${wrongSha}` })));
      r = spawnSync(process.execPath, [CLOUD_RUNNER_MJS, "collect"], { cwd: wt, env, encoding: "utf8" });
      assert.equal(r.status, 2);

      // 4) Post-download EISDIR retains pending & digest; if another shard overwrites out.logs, retry re-fetches A's remote ref (R2-1, R3-2)
      rmSync(outMd, { recursive: true, force: true });
      mkdirSync(outMd, { recursive: true });
      writeFileSync(stateFile, JSON.stringify(makePending()));
      r = spawnSync(process.execPath, [CLOUD_RUNNER_MJS, "collect"], { cwd: wt, env, encoding: "utf8" });
      assert.equal(r.status, 2);
      // Simulate Shard B overwriting out.logs with foreign evidence
      const outLogs = outMd.replace(/\.md$/, ".logs");
      writeFileSync(join(outLogs, "a.log"), "EVIDENCE_FOR_B\n");
      rmSync(outMd, { recursive: true, force: true });
      r = spawnSync(process.execPath, [CLOUD_RUNNER_MJS, "collect"], { cwd: wt, env, encoding: "utf8" });
      assert.equal(r.status, 1);
      assert.equal(readFileSync(join(outLogs, "a.log"), "utf8").includes("EVIDENCE_FOR_A"), true);
    } finally {
      rmSync(hostRoot, { recursive: true, force: true });
    }
  } finally {
    sb.cleanup();
  }
});

test("old cache schema migration, workspace manifest refresh, nested runner isolation, and SHA prefix matching (R1-14, R3-4, R3-6, R3-7)", () => {
  const innerSb = setupVmSandbox(['false; rc=$?; printf "\\nRED_EXIT=%s\\n" "$rc"']);
  const outerSb = setupVmSandbox([
    `bash "${join(innerSb.cloudDir, "run-tests.sh")}" --branch phase06/cloudrun --sha ${innerSb.sha} --lane inner --spec-ref refs/test-specs/inner/${innerSb.sha} --spec-sha256 ${createHash("sha256").update('false; rc=$?; printf "\\nRED_EXIT=%s\\n" "$rc"\n').digest("hex")} --log-repo https://github.com/zone17th/engram-test-logs >/dev/null`,
  ]);
  try {
    // Seed an R1-shaped old cache (single-file provision checksum, two-file locks checksum)
    writeFileSync(join(outerSb.stateDir, "installed"), "");
    writeFileSync(join(outerSb.stateDir, "provision"), "0000  old\n");
    writeFileSync(join(outerSb.stateDir, "locks"), "0000  pnpm-lock.yaml\n");

    // Run with a 10-char SHA prefix of fullSha (R3-6) while running nested innerSb inside the spec command (R3-4)
    const sha10 = outerSb.fullSha.slice(0, 10);
    const { status, report, events } = outerSb.run(["--sha", sha10]);
    assert.equal(status, 0);
    assert.equal(report.stage_outcome, "succeeded");
    assert.equal(report.test_verdict, "pass", `nested inner runner must not corrupt outer results: ${JSON.stringify(report)}`);
    assert.equal(report.sha, sha10);
    assert.equal(events.some((e) => e.includes("provision-engram.sh")), true, "old provision schema must trigger provision");
    assert.equal(events.some((e) => e.includes("pnpm install --frozen-lockfile")), true, "old locks schema must trigger pnpm refresh");

    // Modifying packages/crypto-vectors/package.json triggers dependency refresh on the next warm round
    writeFileSync(outerSb.eventsLog, "");
    writeFileSync(join(outerSb.repoDir, "packages", "crypto-vectors", "package.json"), '{"name":"@engram/crypto-vectors","version":"0.0.2"}\n');
    const warm = outerSb.run();
    assert.equal(warm.report.test_verdict, "pass");
    assert.equal(warm.events.some((e) => e.includes("pnpm install --frozen-lockfile")), true, "crypto-vectors manifest change must refresh deps");

    // Mismatched 9th SHA character is rejected before running
    const wrong9 = outerSb.fullSha.slice(0, 8) + (outerSb.fullSha[8] === "0" ? "1" : "0");
    const badSha = outerSb.run(["--sha", wrong9]);
    assert.equal(badSha.report.stage_outcome, "failed");
    assert.equal(badSha.report.test_verdict, "blocked");
  } finally {
    innerSb.cleanup();
    outerSb.cleanup();
  }
});

test("close cleans only configured/recorded logRepos without leaking URL credentials, and start-engram bridge client retries delayed listener (R2-2, R2-3, R3-3, R3-5, R3-7)", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "engram-close-test-"));
  try {
    const wt = join(hostRoot, "wt");
    const bin = join(hostRoot, "bin");
    const gitCalls = join(hostRoot, "git.log");
    mkdirSync(wt, { recursive: true });
    mkdirSync(bin, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "phase06/cloudrun"], { cwd: wt });
    writeFileSync(join(wt, "README.md"), "t\n");
    execFileSync("git", ["add", "README.md"], { cwd: wt });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-qm", "init"], { cwd: wt });

    const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/usr/bin/env bash
if [ "$1" = "ls-remote" ]; then
  echo "git $*" >> "${gitCalls}"
  if [[ "$*" == *"uniwork"* ]]; then exit 128; fi
  exit 0
fi
exec "${realGit}" "$@"
`, { mode: 0o755 });

    const secretUrl = "https://demo:SUPER_SECRET_URL_PASS@github.com/zone17th/engram-test-logs";
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CURSOR_API_KEY: "test_key",
      CLOUD_RUNNER_LOG_REPO: secretUrl,
      CLOUD_RUNNER_BOOT_REPO: secretUrl,
    };
    writeFileSync(join(wt, ".git", "cloud-runner.json"), JSON.stringify({
       via: "direct",
      branch: "phase06/cloudrun",
      lane: "cloudrun",
      lanes: ["cloudrun"],
      logRepos: ["https://github.com/zone17th/engram-test-logs"],
    }));

    const r = spawnSync(process.execPath, [CLOUD_RUNNER_MJS, "close"], { cwd: wt, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const combinedOut = `${r.stdout}\n${r.stderr}`;
    assert.equal(combinedOut.includes("SUPER_SECRET_URL_PASS"), false, "close output must not leak URL password");
    const calls = readFileSync(gitCalls, "utf8");
    assert.equal(calls.includes("uniwork"), false, "close must not query unused uniwork repo");

    // Exercise ensure: dead-agent replacement preserves historical logRepos (R3-3) and warm ensure shares startedAt budget across 409 retries (R2-4)
    let mode = "replace";
    let postRuns = 0;
    const apiSrv = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (mode === "replace") {
        if (req.method === "GET" && req.url === "/v1/agents/bc-dead") {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/agents") {
          res.end(JSON.stringify({ agent: { id: "bc-new" }, run: { id: "run-prov-1" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/agents/bc-new/runs/run-prov-1") {
          res.end(JSON.stringify({ status: "FINISHED", result: '```json\n{"sha":"12345678","stage_outcome":"succeeded","test_verdict":"not_run"}\n```' }));
          return;
        }
      } else {
        if (req.method === "GET" && req.url === "/v1/agents/bc-busy") {
          res.end(JSON.stringify({ id: "bc-busy", status: "IDLE" }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/agents/bc-busy/runs") {
          postRuns += 1;
          if (postRuns === 1) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: "agent_busy" }));
          } else {
            res.end(JSON.stringify({ run: { id: "run-busy-1" } }));
          }
          return;
        }
        if (req.method === "GET" && req.url === "/v1/agents/bc-busy/runs/run-busy-1") {
          res.end(JSON.stringify({ status: "RUNNING" }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/agents/bc-busy/runs/run-busy-1/cancel") {
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise((resolve) => apiSrv.listen(0, "127.0.0.1", resolve));
    const apiPort = apiSrv.address().port;
    try {
      const apiEnv = {
        ...env,
        CLOUD_RUNNER_API_URL: `http://127.0.0.1:${apiPort}/v1`,
        CLOUD_RUNNER_POLL_MS: "250",
      };
      writeFileSync(join(wt, ".git", "cloud-runner.json"), JSON.stringify({
        agentId: "bc-dead",
        via: "direct",
        branch: "phase06/cloudrun",
        lane: "old-lane",
        lanes: ["old-lane"],
        logRepos: ["https://github.com/UNIAI-TEAM/uniwork"],
        provisioned: false,
      }));
      const runAsync = (args) => new Promise((resolve) => {
        const child = spawn(process.execPath, [CLOUD_RUNNER_MJS, ...args], { cwd: wt, env: apiEnv });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      const repEnsure = await runAsync(["ensure"]);
      assert.equal(repEnsure.status, 0, repEnsure.stderr);
      const newState = JSON.parse(readFileSync(join(wt, ".git", "cloud-runner.json"), "utf8"));
      assert.equal(newState.logRepos.includes("https://github.com/UNIAI-TEAM/uniwork"), true, "ensure replacement must preserve historical logRepos");
      assert.equal(newState.logRepos.includes("https://github.com/zone17th/engram-test-logs"), true);

      mode = "busy";
      writeFileSync(join(wt, ".git", "cloud-runner.json"), JSON.stringify({
        agentId: "bc-busy",
        via: "direct",
        branch: "phase06/cloudrun",
        lane: "cloudrun",
        lanes: ["cloudrun"],
        logRepos: ["https://github.com/zone17th/engram-test-logs"],
        provisioned: false,
      }));
      const t0 = Date.now();
      const busyEnsure = await runAsync(["ensure", "--timeout", "1"]);
      const elapsedMs = Date.now() - t0;
      assert.equal(busyEnsure.status, 2);
      assert.equal(elapsedMs < 1800, true, `warm ensure must share 1s timeout budget across 409 + polling (took ${elapsedMs}ms)`);
    } finally {
      apiSrv.closeAllConnections?.();
      apiSrv.close();
    }
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
  }

  // Exercise the exact bridge-probe client expression from start-engram.sh against a local TCP server that starts 300ms late (R2-3)
  const startSrc = readFileSync(START_ENGRAM_SH, "utf8");
  const m = /node -e "([^"]+dial\(\)[^"]+)"/.exec(startSrc);
  assert.ok(m, "bridge probe client expression present in start-engram.sh");
  const probePort = 45432 + Math.floor(Math.random() * 2000);
  const clientCode = m[1].replace("5432", String(probePort)).replace("${srv_ip:-engram-probe-srv}", "127.0.0.1");

  const srv = net.createServer((s) => s.end("ok"));
  setTimeout(() => srv.listen(probePort, "127.0.0.1"), 300);
  try {
    const exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", clientCode]);
      child.on("close", resolve);
    });
    assert.equal(exitCode, 0, "bridge probe client must succeed when listener starts after 300ms");
  } finally {
    srv.close();
  }
});
