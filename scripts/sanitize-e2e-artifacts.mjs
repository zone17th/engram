import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_SCREENSHOT_NAMES = new Set([
  'login-en-light.png',
  'login-en-dark.png',
  'login-vi-light.png',
  'login-vi-dark.png',
  'signup-en-light.png',
  'signup-en-dark.png',
]);
const SAFE_PROJECT_NAMES = new Set(['mobile-390', 'tablet-768', 'desktop-1440']);

function projectNameFromPath(relativeSource) {
  for (const segment of relativeSource) {
    if (SAFE_PROJECT_NAMES.has(segment)) return segment;
    for (const project of SAFE_PROJECT_NAMES) {
      if (segment.endsWith(`-${project}`)) return project;
    }
  }
  return 'unknown';
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function assertOutputRootInsideData(root, outputRoot) {
  const dataRoot = resolve(root, '.data');
  const resolvedOutput = resolve(outputRoot);
  const relativeOutput = relative(dataRoot, resolvedOutput);
  if (
    !relativeOutput ||
    relativeOutput === '..' ||
    relativeOutput.startsWith(`..${sep}`) ||
    isAbsolute(relativeOutput)
  ) {
    throw new Error(`refusing to clear artifact output outside ${dataRoot}`);
  }
}

function copySafeScreenshots(resultsRoot, destinationRoot) {
  const copied = [];
  for (const source of walkFiles(resultsRoot)) {
    const name = basename(source);
    if (!SAFE_SCREENSHOT_NAMES.has(name)) continue;
    const rel = relative(resultsRoot, source).split(sep);
    const project = projectNameFromPath(rel);
    const destinationName = `${project}-${name}`;
    mkdirSync(destinationRoot, { recursive: true });
    copyFileSync(source, join(destinationRoot, destinationName));
    copied.push(destinationName);
  }
  return copied;
}

export function collectArtifacts({
  root = ROOT,
  resultsRoot = resolve(root, 'apps', 'web', 'test-results'),
  outputRoot = resolve(root, '.data', 'e2e-artifacts'),
} = {}) {
  assertOutputRootInsideData(root, outputRoot);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const screenshots = copySafeScreenshots(resultsRoot, join(outputRoot, 'a11y-screenshots'));
  const parsedExitStatus = Number.parseInt(process.env.E2E_EXIT_STATUS ?? '', 10);
  writeFileSync(
    join(outputRoot, 'manifest.json'),
    `${JSON.stringify(
      {
        artifactPolicy: 'allowlisted-a11y-screenshots-only',
        reportIncluded: false,
        rawTestResultsIncluded: false,
        traceIncluded: false,
        videoIncluded: false,
        exitStatus: Number.isInteger(parsedExitStatus) ? parsedExitStatus : null,
        screenshots,
      },
      null,
    )}\n`,
  );
  return { screenshots, outputRoot };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = collectArtifacts();
  console.log(`Staged ${result.screenshots.length} allowlisted a11y screenshots.`);
}
