import type { MatrixCommand } from './matrix-specs';

/**
 * Executable reference model of the specified Worker/client command contract (ADR 0002 §7, §10, §11).
 * It is deliberately independent of worker-core.ts: it encodes only the externally specified behaviour.
 *
 *  - state-changing commands run strictly one at a time (serial queue); `lock` preempts and runs at once;
 *  - read-only commands run against the committed state captured at start and re-check before replying;
 *  - a non-whitelisted command in `recovering` is rejected at start (no KDF) and at commit;
 *  - at client level a second state-changing call while one is in flight is `CLIENT_BUSY` (never sent).
 */

export type ModelMode = 'locked' | 'unlocked' | 'recovering';
export type VaultId = 'orig' | 'created';

export type ModelOutcome = { ok: true } | { ok: false; code: string };

export interface ModelState {
  mode: ModelMode;
  pending: boolean;
  pendingGen: number;
  /** Which vault's key the Worker holds (null when no key is held). */
  vk: VaultId | null;
  /** The vault a later unlock reads from persisted storage (last vault whose key was installed). */
  active: VaultId;
  version: number;
  gen: number;
}

export type PersistEvent = { id: string; kind: 'create' | 'rewrap'; vault: VaultId };

const STATE_COMMANDS = new Set<MatrixCommand>([
  'createVault',
  'unlockPassphrase',
  'unlockRecovery',
  'unlockRecoveryWrap',
  'resumeRecovery',
  'confirmRecovery',
  'unlockPrf',
  'unlockDevKey',
  'rewrap',
]);

export function isStateCommand(cmd: MatrixCommand): boolean {
  return STATE_COMMANDS.has(cmd);
}

/** Commands that can be parked at their last Worker await. */
export const HOLD_CAPABLE = new Set<MatrixCommand>([
  'createVault',
  'unlockPassphrase',
  'rewrap',
  'unlockDevKey',
  'wrapForDevice',
]);

interface Plan {
  reject?: string;
  /** Side effect applied even though the command is rejected (stale continuation disposal). */
  rejectEffect?: (m: ModelState) => void;
  holds: boolean;
  effect: (m: ModelState) => void;
  persist?: PersistEvent['kind'];
}

interface HeldItem {
  id: string;
  cmd: MatrixCommand;
  state: boolean;
  stale: boolean;
  plan?: Plan;
  snapshot: { gen: number; version: number; vk: VaultId | null };
}

interface QueuedItem {
  id: string;
  cmd: MatrixCommand;
  gen: number;
}

export interface ModelOptions {
  level: 'client' | 'worker';
}

const OK: ModelOutcome = { ok: true };
const fail = (code: string): ModelOutcome => ({ ok: false, code });

function unlockEffect(vault: VaultId) {
  return (m: ModelState): void => {
    m.mode = 'unlocked';
    m.pending = false;
    m.vk = vault;
    m.active = vault;
    m.version += 1;
  };
}

export class WorkerModel {
  readonly state: ModelState;
  readonly settled = new Map<string, ModelOutcome>();
  readonly persistEvents: PersistEvent[] = [];
  private held: HeldItem[] = [];
  private queue: QueuedItem[] = [];
  private slotHolder: string | null = null;
  private readonly level: 'client' | 'worker';

  constructor(
    initial: Pick<ModelState, 'mode' | 'pending' | 'vk'>,
    opts: ModelOptions,
  ) {
    this.level = opts.level;
    this.state = {
      mode: initial.mode,
      pending: initial.pending,
      pendingGen: 0,
      vk: initial.vk,
      active: 'orig',
      version: 0,
      gen: 0,
    };
  }

  private settle(id: string, outcome: ModelOutcome): void {
    this.settled.set(id, outcome);
    if (this.slotHolder === id) this.slotHolder = null;
  }

  private stateRunning(): boolean {
    return this.held.some((h) => h.state);
  }

  private plan(cmd: MatrixCommand, gen: number): Plan {
    const s = this.state;
    switch (cmd) {
      case 'createVault':
        return {
          holds: true,
          persist: 'create',
          effect: (m) => {
            m.mode = 'unlocked';
            m.pending = false;
            m.vk = 'created';
            m.active = 'created';
            m.version += 1;
          },
        };
      case 'unlockPassphrase':
      case 'unlockDevKey':
        return { holds: true, effect: unlockEffect('orig') };
      case 'unlockPrf':
        return { holds: false, effect: unlockEffect('orig') };
      case 'unlockRecovery':
        return {
          holds: false,
          effect: (m) => {
            if (m.pending) m.version += 1;
            m.pending = true;
            m.pendingGen = gen;
            m.version += 1;
          },
        };
      case 'unlockRecoveryWrap':
        return {
          holds: false,
          effect: (m) => {
            if (m.pending) m.version += 1;
            m.mode = 'recovering';
            m.pending = false;
            m.vk = 'orig';
            m.active = 'orig';
            m.version += 1;
          },
        };
      case 'resumeRecovery': {
        if (!s.pending) return { holds: false, reject: 'RECOVERY_CONTINUATION_MISSING', effect: () => {} };
        if (s.pendingGen !== gen) {
          return {
            holds: false,
            reject: 'STALE_GENERATION',
            rejectEffect: (m) => {
              m.pending = false;
              m.version += 1;
            },
            effect: () => {},
          };
        }
        return {
          holds: false,
          effect: (m) => {
            m.mode = 'recovering';
            m.pending = false;
            m.vk = 'orig';
            m.active = 'orig';
            m.version += 2;
          },
        };
      }
      case 'confirmRecovery':
        if (s.mode === 'locked') return { holds: false, reject: 'VAULT_LOCKED', effect: () => {} };
        if (s.mode === 'unlocked') {
          return { holds: false, reject: 'VAULT_NOT_RECOVERING', effect: () => {} };
        }
        return {
          holds: false,
          effect: (m) => {
            m.mode = 'unlocked';
            m.version += 1;
          },
        };
      case 'rewrap':
        if (s.mode === 'locked') return { holds: false, reject: 'VAULT_LOCKED', effect: () => {} };
        return {
          holds: true,
          persist: 'rewrap',
          effect: (m) => {
            if (m.mode === 'recovering') m.version += 1;
          },
        };
      default:
        throw new Error(`not a state command: ${cmd}`);
    }
  }

  /** Whether posting `cmd` right now would park it at its last Worker await. */
  predictHold(cmd: MatrixCommand, gen: number): boolean {
    if (!HOLD_CAPABLE.has(cmd)) return false;
    if (gen !== this.state.gen) return false;
    if (isStateCommand(cmd)) {
      if (this.level === 'client' && this.slotHolder) return false;
      if (this.stateRunning()) return false;
      if (this.state.mode === 'recovering' && cmd !== 'rewrap') return false;
      const plan = this.plan(cmd, gen);
      return !plan.reject && plan.holds;
    }
    // wrapForDevice: start checks, then parked at the second await
    return this.state.mode === 'unlocked';
  }

  /** Whether the client would reject this call as CLIENT_BUSY (client level only). */
  wouldBeBusy(cmd: MatrixCommand): boolean {
    return this.level === 'client' && isStateCommand(cmd) && this.slotHolder !== null;
  }

  post(id: string, cmd: MatrixCommand, gen: number, hold: boolean): void {
    const s = this.state;
    if (cmd === 'lock') {
      s.gen += 1;
      s.mode = 'locked';
      s.pending = false;
      s.vk = null;
      s.version += 1;
      this.slotHolder = null;
      for (const h of this.held) h.stale = true;
      for (const q of this.queue.splice(0)) this.settle(q.id, fail('STALE_GENERATION'));
      this.settle(id, OK);
      return;
    }
    if (isStateCommand(cmd)) {
      if (this.level === 'client') {
        if (this.slotHolder) {
          this.settle(id, fail('CLIENT_BUSY'));
          return;
        }
        if (gen !== s.gen) {
          // assertGenerationOrWipe: rejected before any Worker contact
          this.settle(id, fail('STALE_GENERATION'));
          return;
        }
        this.slotHolder = id;
      }
      if (this.stateRunning()) {
        this.queue.push({ id, cmd, gen });
        return;
      }
      this.startState(id, cmd, gen, hold);
      return;
    }
    if (this.level === 'client' && gen !== s.gen) {
      this.settle(id, fail('STALE_GENERATION'));
      return;
    }
    this.startReadOnly(id, cmd, gen, hold);
  }

  private adoptGeneration(cmd: MatrixCommand, gen: number): void {
    const s = this.state;
    if (s.mode === 'locked' && s.vk === null && gen > s.gen) {
      if (cmd !== 'resumeRecovery') s.pending = false;
      s.gen = gen;
      s.version += 1;
    }
  }

  private startState(id: string, cmd: MatrixCommand, gen: number, hold: boolean): void {
    const s = this.state;
    this.adoptGeneration(cmd, gen);
    if (gen !== s.gen) {
      this.settle(id, fail('STALE_GENERATION'));
      this.drain();
      return;
    }
    if (s.mode === 'recovering' && cmd !== 'rewrap' && cmd !== 'confirmRecovery') {
      this.settle(id, fail('VAULT_RECOVERING'));
      this.drain();
      return;
    }
    const plan = this.plan(cmd, gen);
    if (plan.reject) {
      plan.rejectEffect?.(s);
      this.settle(id, fail(plan.reject));
      this.drain();
      return;
    }
    if (plan.holds && hold) {
      this.held.push({
        id,
        cmd,
        state: true,
        stale: false,
        plan,
        snapshot: { gen: s.gen, version: s.version, vk: s.vk },
      });
      return;
    }
    this.commit(id, plan);
    this.drain();
  }

  private commit(id: string, plan: Plan): void {
    const s = this.state;
    const vaultBefore = s.vk;
    plan.effect(s);
    if (plan.persist === 'create') {
      this.persistEvents.push({ id, kind: 'create', vault: 'created' });
    } else if (plan.persist === 'rewrap' && vaultBefore) {
      this.persistEvents.push({ id, kind: 'rewrap', vault: vaultBefore });
    }
    this.settle(id, OK);
  }

  private drain(): void {
    while (!this.stateRunning() && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.startState(next.id, next.cmd, next.gen, false);
    }
  }

  private startReadOnly(id: string, cmd: MatrixCommand, gen: number, hold: boolean): void {
    const s = this.state;
    this.adoptGeneration(cmd, gen);
    if (gen !== s.gen) {
      this.settle(id, fail('STALE_GENERATION'));
      return;
    }
    if (s.mode === 'recovering') {
      this.settle(id, fail('VAULT_RECOVERING'));
      return;
    }
    if (s.mode === 'locked') {
      this.settle(id, fail('VAULT_LOCKED'));
      return;
    }
    if (cmd === 'openEntry' && s.vk !== 'orig') {
      this.settle(id, fail('AEAD_DECRYPT_FAILED'));
      return;
    }
    if (cmd === 'wrapForDevice' && hold) {
      this.held.push({
        id,
        cmd,
        state: false,
        stale: false,
        snapshot: { gen: s.gen, version: s.version, vk: s.vk },
      });
      return;
    }
    this.settle(id, OK);
  }

  /** Releases the held command `id` (it proceeds from its last await). */
  release(id: string): void {
    const idx = this.held.findIndex((h) => h.id === id);
    if (idx < 0) throw new Error(`model: ${id} is not held`);
    const item = this.held.splice(idx, 1)[0]!;
    const s = this.state;
    if (item.state) {
      if (item.stale || item.snapshot.gen !== s.gen) {
        this.settle(id, fail('STALE_GENERATION'));
      } else {
        this.commit(id, item.plan!);
      }
      this.drain();
      return;
    }
    if (s.mode === 'recovering') {
      this.settle(id, fail('VAULT_RECOVERING'));
    } else if (
      item.stale ||
      item.snapshot.gen !== s.gen ||
      item.snapshot.version !== s.version ||
      item.snapshot.vk !== s.vk
    ) {
      this.settle(id, fail('STALE_GENERATION'));
    } else {
      this.settle(id, OK);
    }
  }

  heldItems(): Array<{ id: string; cmd: MatrixCommand }> {
    return this.held.map((h) => ({ id: h.id, cmd: h.cmd }));
  }
}
