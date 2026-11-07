import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_TESTS_SH = join(HERE, "run-tests.sh");
const SPECS_DIR = join(HERE, "specs");

function setupVmSandbox(specLines, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "engram-runner-test-"));
  const home = join(root, "home");
  const cloudDir = join(home, ".engram-cloud", ".cursor", "cloud");
  const stateDir = join(home, ".engram-cloud", "state");
  const repoDir = join(root, "repo");
  const binDir = join(root, "bin");
  const pushLog = join(root, "pushes.log");
  mkdirSync(cloudDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(repoDir, "apps", "api"), { recursive: true });
  mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
  mkdirSync(join(repoDir, "infra"), { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(join(cloudDir, "run-tests.sh"), readFileSync(RUN_TESTS_SH));
  for (const s of ["provision-engram.sh", "install-engram.sh", "start-engram.sh"]) {
    writeFileSync(join(cloudDir, s), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  }
  writeFileSync(join(repoDir, "package.json"), "{}\n");
  writeFileSync(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repoDir, "apps", "api", "go.mod"), "module engram\ngo 1.26.0\n");
  writeFileSync(join(repoDir, "apps", "api", "go.sum"), "\n");
  writeFileSync(join(repoDir, ".github", "workflows", "ci.yml"), "go-version: '1.27.3'\n");
  writeFileSync(join(repoDir, "infra", "image-pins.env"), "NODE_IMAGE=node:22\n");

  execFileSync("git", ["init", "-q", "-b", "phase06/cloudrun"], { cwd: repoDir });
  execFileSync("git", ["add", "-A"], { cwd: repoDir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-qm", "init"], { cwd: repoDir });
  const sha = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

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
    sha,
    pushLog,
    run(args = []) {
      const env = {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH}`,
        ...extraEnv,
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
      return { status: r.status, report, pushes, stderr: r.stderr };
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

test("redacts secret values and token-shaped strings from failure JSON (R1-2)", () => {
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

test("spec files parse cleanly with bash -n and full.txt matches the 5 grouped specs", () => {
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
});

test("host collect returns 1 on marker-only failure, rejects command/8-char-SHA drift, and recovers post-download write failure (R1-6, R1-9, R1-24, R2-1)", () => {
  const cmd = 'false; rc=$?; printf "\\nRED_EXIT=%s\\n" "$rc"';
  const sb = setupVmSandbox([cmd]);
  try {
    const { report } = sb.run();
    assert.equal(report.test_verdict, "fail");
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
      writeFileSync(join(logCommitDir, "a.log"), `$ ${cmd}\n\nRED_EXIT=1\n`);
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
          expectedCommands: [cmd],
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

      // 1) Command mismatch rejected with exit 2 (R1-6)
      writeFileSync(stateFile, JSON.stringify(makePending({ expectedCommands: ["different command"] })));
      let r = spawnSync(process.execPath, [join(HERE, "cloud-runner.mjs"), "collect"], { cwd: wt, env, encoding: "utf8" });
      assert.equal(r.status, 2);

      // 2) 8th SHA char mismatch rejected with exit 2 before fetch (R1-9)
      const wrongSha = sb.sha.slice(0, 7) + (sb.sha[7] === "0" ? "1" : "0");
      writeFileSync(stateFile, JSON.stringify(makePending({}, { sha: wrongSha, log_ref: `refs/test-results/engram/cloudrun/${wrongSha}` })));
      r = spawnSync(process.execPath, [join(HERE, "cloud-runner.mjs"), "collect"], { cwd: wt, env, encoding: "utf8" });
      assert.equal(r.status, 2);

      // 3) Post-download report write failure retains pending & logs, then recovers on retry and returns 1 for marker-only failure (R2-1, R1-24)
      rmSync(outMd, { recursive: true, force: true });
      mkdirSync(outMd, { recursive: true }); // cause EISDIR on writeReport after fetchLogs succeeds
      writeFileSync(stateFile, JSON.stringify(makePending()));
      r = spawnSync(process.execPath, [join(HERE, "cloud-runner.mjs"), "collect"], { cwd: wt, env, encoding: "utf8" });
      assert.equal(r.status, 2);
      rmSync(outMd, { recursive: true, force: true });
      r = spawnSync(process.execPath, [join(HERE, "cloud-runner.mjs"), "collect"], { cwd: wt, env, encoding: "utf8" });
      assert.equal(r.status, 1, `expected exit 1 for marker-only failure, got ${r.status}: ${r.stderr}`);
      assert.equal(readFileSync(outMd, "utf8").includes("test_verdict: **fail**"), true);
    } finally {
      rmSync(hostRoot, { recursive: true, force: true });
    }
  } finally {
    sb.cleanup();
  }
});
