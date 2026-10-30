// Pure enumeration of the state-fence matrix. No imports and only erasable TypeScript syntax, so the opt-in
// `matrix:list` script can load it with Node's native type stripping (it must stay free of fs access).

export type MatrixCommand =
  | 'createVault'
  | 'unlockPassphrase'
  | 'unlockRecovery'
  | 'unlockRecoveryWrap'
  | 'resumeRecovery'
  | 'confirmRecovery'
  | 'unlockPrf'
  | 'unlockDevKey'
  | 'rewrap'
  | 'makeRecoveryKeys'
  | 'wrapForPasskey'
  | 'wrapForDevice'
  | 'sealEntry'
  | 'openEntry'
  | 'lock';

export type MatrixStartMode =
  | 'locked'
  | 'pending-continuation'
  | 'recovering'
  | 'recovering-after-rewrap'
  | 'unlocked';

export type MatrixModeChange = 'lock' | 'enterRecovering' | 'confirmRecovery' | 'ordinaryUnlock';

export type MatrixTiming = 'issued-before-paused' | 'issued-during' | 'issued-after';

export type MatrixLevel = 'client' | 'worker';

export interface MatrixCaseSpec {
  name: string;
  level: MatrixLevel;
  command: MatrixCommand;
  startMode: MatrixStartMode;
  modeChange: MatrixModeChange;
  timing: MatrixTiming;
}

export const MATRIX_COMMANDS: readonly MatrixCommand[] = [
  'createVault',
  'unlockPassphrase',
  'unlockRecovery',
  'unlockRecoveryWrap',
  'resumeRecovery',
  'confirmRecovery',
  'unlockPrf',
  'unlockDevKey',
  'rewrap',
  'makeRecoveryKeys',
  'wrapForPasskey',
  'wrapForDevice',
  'sealEntry',
  'openEntry',
  'lock',
];

export const MATRIX_START_MODES: readonly MatrixStartMode[] = [
  'locked',
  'pending-continuation',
  'recovering',
  'recovering-after-rewrap',
  'unlocked',
];

export const MATRIX_MODE_CHANGES: readonly MatrixModeChange[] = [
  'lock',
  'enterRecovering',
  'confirmRecovery',
  'ordinaryUnlock',
];

export const MATRIX_TIMINGS: readonly MatrixTiming[] = [
  'issued-before-paused',
  'issued-during',
  'issued-after',
];

/** Every (start mode x mode change) pair is generated: 5 x 4 = 20 (the r4 matrix skipped 7 of them). */
export function buildMatrixSpecs(level: MatrixLevel): MatrixCaseSpec[] {
  const specs: MatrixCaseSpec[] = [];
  for (const command of MATRIX_COMMANDS) {
    for (const startMode of MATRIX_START_MODES) {
      for (const modeChange of MATRIX_MODE_CHANGES) {
        for (const timing of MATRIX_TIMINGS) {
          specs.push({
            name: `[${level}] cmd=${command} | start=${startMode} | change=${modeChange} | timing=${timing}`,
            level,
            command,
            startMode,
            modeChange,
            timing,
          });
        }
      }
    }
  }
  return specs;
}

export const MATRIX_CASES_PER_LEVEL =
  MATRIX_COMMANDS.length * MATRIX_START_MODES.length * MATRIX_MODE_CHANGES.length * MATRIX_TIMINGS.length;

export type QueueVariant = 'plain' | 'lock-while-held';

export interface QueueCaseSpec {
  name: string;
  first: MatrixCommand;
  second: MatrixCommand;
  startMode: MatrixStartMode;
  variant: QueueVariant;
}

/** Worker serial-queue schedules: a held (parked at its last await) state command, then every state command queued behind it. */
export const QUEUE_HELD_COMMANDS: readonly MatrixCommand[] = [
  'createVault',
  'unlockPassphrase',
  'unlockDevKey',
  'rewrap',
];

export const QUEUE_STATE_COMMANDS: readonly MatrixCommand[] = [
  'createVault',
  'unlockPassphrase',
  'unlockRecovery',
  'unlockRecoveryWrap',
  'resumeRecovery',
  'confirmRecovery',
  'unlockPrf',
  'unlockDevKey',
  'rewrap',
];

export function buildQueueSpecs(): QueueCaseSpec[] {
  const specs: QueueCaseSpec[] = [];
  for (const first of QUEUE_HELD_COMMANDS) {
    for (const second of QUEUE_STATE_COMMANDS) {
      for (const startMode of MATRIX_START_MODES) {
        for (const variant of ['plain', 'lock-while-held'] as const) {
          specs.push({
            name: `[queue] first=${first} | second=${second} | start=${startMode} | variant=${variant}`,
            first,
            second,
            startMode,
            variant,
          });
        }
      }
    }
  }
  return specs;
}
