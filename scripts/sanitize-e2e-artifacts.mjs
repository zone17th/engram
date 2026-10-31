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
  'vault-web-onboarding-step1-light-390.png',
  'vault-web-onboarding-step1-light-1440.png',
  'vault-web-onboarding-step1-dark-390.png',
  'vault-web-onboarding-step1-dark-1440.png',
  'vault-web-onboarding-rk-sheet-light-390.png',
  'vault-web-onboarding-rk-sheet-light-1440.png',
  'vault-web-onboarding-rk-sheet-dark-390.png',
  'vault-web-onboarding-rk-sheet-dark-1440.png',
  'vault-web-unlock-empty-light-390.png',
  'vault-web-unlock-empty-light-1440.png',
  'vault-web-unlock-empty-dark-390.png',
  'vault-web-unlock-empty-dark-1440.png',
  'vault-web-unlock-incorrect-light-390.png',
  'vault-web-unlock-incorrect-light-1440.png',
  'vault-web-unlock-incorrect-dark-390.png',
  'vault-web-unlock-incorrect-dark-1440.png',
  'vault-web-forgot-passphrase-light-390.png',
  'vault-web-forgot-passphrase-light-1440.png',
  'vault-web-forgot-passphrase-dark-390.png',
  'vault-web-forgot-passphrase-dark-1440.png',
  'vault-web-recovery-reauth-light-390.png',
  'vault-web-recovery-reauth-light-1440.png',
  'vault-web-recovery-reauth-dark-390.png',
  'vault-web-recovery-reauth-dark-1440.png',
  'vault-web-recovery-enter-key-light-390.png',
  'vault-web-recovery-enter-key-light-1440.png',
  'vault-web-recovery-enter-key-dark-390.png',
  'vault-web-recovery-enter-key-dark-1440.png',
  'vault-web-recovery-new-passphrase-light-390.png',
  'vault-web-recovery-new-passphrase-light-1440.png',
  'vault-web-recovery-new-passphrase-dark-390.png',
  'vault-web-recovery-new-passphrase-dark-1440.png',
  'vault-web-recovery-regenerate-reauth-light-390.png',
  'vault-web-recovery-regenerate-reauth-light-1440.png',
  'vault-web-recovery-regenerate-reauth-dark-390.png',
  'vault-web-recovery-regenerate-reauth-dark-1440.png',
  'vault-web-recovery-regenerate-keys-light-390.png',
  'vault-web-recovery-regenerate-keys-light-1440.png',
  'vault-web-recovery-regenerate-keys-dark-390.png',
  'vault-web-recovery-regenerate-keys-dark-1440.png',
  'vault-settings-section-light-390.png',
  'vault-settings-section-light-1440.png',
  'vault-settings-section-dark-390.png',
  'vault-settings-section-dark-1440.png',
  'vault-settings-passphrase-dialog-light-390.png',
  'vault-settings-passphrase-dialog-light-1440.png',
  'vault-settings-passphrase-dialog-dark-390.png',
  'vault-settings-passphrase-dialog-dark-1440.png',
  'vault-settings-passphrase-dialog-bottom-light-390.png',
  'vault-settings-passphrase-dialog-bottom-light-1440.png',
  'vault-settings-passphrase-dialog-bottom-dark-390.png',
  'vault-settings-passphrase-dialog-bottom-dark-1440.png',
  'vault-settings-passphrase-done-light-390.png',
  'vault-settings-passphrase-done-light-1440.png',
  'vault-settings-passphrase-done-dark-390.png',
  'vault-settings-passphrase-done-dark-1440.png',
  'vault-settings-rk-sheet-light-390.png',
  'vault-settings-rk-sheet-light-1440.png',
  'vault-settings-rk-sheet-dark-390.png',
  'vault-settings-rk-sheet-dark-1440.png',
  'vault-settings-rk-sheet-bottom-light-390.png',
  'vault-settings-rk-sheet-bottom-light-1440.png',
  'vault-settings-rk-sheet-bottom-dark-390.png',
  'vault-settings-rk-sheet-bottom-dark-1440.png',
  'vault-settings-reset-step1-light-390.png',
  'vault-settings-reset-step1-light-1440.png',
  'vault-settings-reset-step1-dark-390.png',
  'vault-settings-reset-step1-dark-1440.png',
  'vault-settings-reset-step1-bottom-light-390.png',
  'vault-settings-reset-step1-bottom-light-1440.png',
  'vault-settings-reset-step1-bottom-dark-390.png',
  'vault-settings-reset-step1-bottom-dark-1440.png',
  'vault-settings-reset-confirm-light-390.png',
  'vault-settings-reset-confirm-light-1440.png',
  'vault-settings-reset-confirm-dark-390.png',
  'vault-settings-reset-confirm-dark-1440.png',
  'vault-settings-locked-banner-light-390.png',
  'vault-settings-locked-banner-light-1440.png',
  'vault-settings-locked-banner-dark-390.png',
  'vault-settings-locked-banner-dark-1440.png',
  'vault-settings-absent-banner-light-390.png',
  'vault-settings-absent-banner-light-1440.png',
  'vault-settings-absent-banner-dark-390.png',
  'vault-settings-absent-banner-dark-1440.png',
  'vault-web-locked-list-light-390.png',
  'vault-web-locked-list-light-1440.png',
  'vault-web-locked-list-dark-390.png',
  'vault-web-locked-list-dark-1440.png',
  'vault-web-locked-item-light-390.png',
  'vault-web-locked-item-light-1440.png',
  'vault-web-locked-item-dark-390.png',
  'vault-web-locked-item-dark-1440.png',
  'vault-passkey-unlock-card-light-390.png',
  'vault-passkey-unlock-card-light-1440.png',
  'vault-passkey-unlock-card-dark-390.png',
  'vault-passkey-unlock-card-dark-1440.png',
  'vault-passkey-add-dialog-light-390.png',
  'vault-passkey-add-dialog-light-1440.png',
  'vault-passkey-add-dialog-dark-390.png',
  'vault-passkey-add-dialog-dark-1440.png',
  'vault-b-onboarding-step3-light-390.png',
  'vault-b-onboarding-step3-light-1440.png',
  'vault-b-onboarding-step3-dark-390.png',
  'vault-b-onboarding-step3-dark-1440.png',
  'vault-b-forgot-light-390.png',
  'vault-b-forgot-light-1440.png',
  'vault-b-forgot-dark-390.png',
  'vault-b-forgot-dark-1440.png',
  'vault-b-unlock-long-email-light-390.png',
  'vault-b-unlock-long-email-light-1440.png',
  'vault-b-unlock-long-email-dark-390.png',
  'vault-b-unlock-long-email-dark-1440.png',
  'vault-b-settings-passkeys-light-390.png',
  'vault-b-settings-passkeys-light-1440.png',
  'vault-b-settings-passkeys-dark-390.png',
  'vault-b-settings-passkeys-dark-1440.png',
  'vault-b-settings-autolock-light-390.png',
  'vault-b-settings-autolock-light-1440.png',
  'vault-b-settings-autolock-dark-390.png',
  'vault-b-settings-autolock-dark-1440.png',
  'vault-b-onboarding-step3-remember-light-390.png',
  'vault-b-onboarding-step3-remember-light-1440.png',
  'vault-b-onboarding-step3-remember-dark-390.png',
  'vault-b-onboarding-step3-remember-dark-1440.png',
  'vault-b-settings-device-light-390.png',
  'vault-b-settings-device-light-1440.png',
  'vault-b-settings-device-dark-390.png',
  'vault-b-settings-device-dark-1440.png',
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
