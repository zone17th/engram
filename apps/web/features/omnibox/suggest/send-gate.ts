/**
 * Pure keystroke send-gate and request classifier for P05 search & suggest
 * per plan P05 mục 2.1, mục 2.24 (items 1, 2, 8, 9), and SPEC §3.4, §3.5, §6.8.
 *
 * Security invariants:
 * - Never sends keystroke requests when draft is tainted (paste/drop/undo/replacement/
 *   multi-grapheme outside composition/missing inputType/foreign value write/composition > 64 graphemes),
 *   colon-locked (`:` or `：` anywhere, or add/add-invalid mode, latched until field is empty `''`),
 *   composing, multi-line, or > 200 runes (> 50 runes in `#` tag mode).
 * - `#` mode sends ONLY the token between `#` and the first whitespace or `:` (when not colon-locked),
 *   with `scope='tag'` and ALWAYS `semantic=0`.
 * - Every request (`/suggest` or `/search`, including keystroke, Enter, toggle-on re-issue,
 *   retry after `Retry-After`, and "see more" cursor pages) gets `semantic=1` ONLY when the draft
 *   is gate-clean at send time AND satisfies SPEC §3.5 rule 7
 *   (`semantic_available && semantic_suggest && len_runes(qn) >= 3 && mode !== 'recent' && scope !== 'tag' && !cursor`).
 */

import {
  QUERY_MAX_RUNES,
  TAG_QUERY_MAX_RUNES,
  countRunes,
  isUnicodeWhiteSpace,
  normalizeQuery,
  normalizeTagQuery,
  trimUnicodeWhiteSpace,
} from '../normalize';
import { parseQuickAdd } from '../quick-add-parse';
import type { SearchScope, SemanticParam, SuggestMode } from '@/lib/api/search';
import type { SearchRequestMode } from './query-keys';

export const SUGGEST_DEBOUNCE_MS = 120;
export const COMPOSITION_COMMIT_MAX_GRAPHEMES = 64;
export const SEMANTIC_MIN_QUERY_RUNES = 3;

/**
 * Allowlist of `InputEvent.inputType` values that keep a draft untainted (plan mục 2.1 rule 1, SPEC §3.5 rule 1).
 * Note: `insertLineBreak` and `insertParagraph` are intentionally excluded so multi-line inputs taint.
 */
export const ALLOWED_INPUT_TYPES: Readonly<Record<string, true>> = {
  insertText: true,
  insertCompositionText: true,
  insertFromComposition: true,
  deleteCompositionText: true,
  deleteContent: true,
  deleteContentBackward: true,
  deleteContentForward: true,
  deleteWordBackward: true,
  deleteWordForward: true,
  deleteSoftLineBackward: true,
  deleteSoftLineForward: true,
  deleteHardLineBackward: true,
  deleteHardLineForward: true,
  deleteByCut: true,
};

const DELETE_INPUT_TYPES: Readonly<Record<string, true>> = {
  deleteCompositionText: true,
  deleteContent: true,
  deleteContentBackward: true,
  deleteContentForward: true,
  deleteWordBackward: true,
  deleteWordForward: true,
  deleteSoftLineBackward: true,
  deleteSoftLineForward: true,
  deleteHardLineBackward: true,
  deleteHardLineForward: true,
  deleteByCut: true,
};

const COMPOSITION_INPUT_TYPES: Readonly<Record<string, true>> = {
  insertCompositionText: true,
  insertFromComposition: true,
  deleteCompositionText: true,
};

let cachedGraphemeSegmenter: Intl.Segmenter | null = null;

function getGraphemeSegmenter(): Intl.Segmenter {
  if (cachedGraphemeSegmenter) {
    return cachedGraphemeSegmenter;
  }
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    throw new Error('Intl.Segmenter is required for omnibox send-gate grapheme counting.');
  }
  cachedGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return cachedGraphemeSegmenter;
}

/**
 * Counts extended grapheme clusters in `text` using `Intl.Segmenter`.
 * Fails loudly if `Intl.Segmenter` is unavailable.
 */
export function countGraphemes(text: string, stopAfter?: number): number {
  const segmenter = getGraphemeSegmenter();
  if (text === '') return 0;
  let count = 0;
  for (const _ of segmenter.segment(text)) {
    count += 1;
    if (stopAfter !== undefined && count > stopAfter) {
      return count;
    }
  }
  return count;
}

/**
 * Checks whether `value` contains ASCII `:` (U+003A) or full-width `：` (U+FF1A) anywhere
 * across any line or mode (including `#` and `://`), or parses as `add`/`add-invalid` via `parseQuickAdd`.
 */
export function hasColonOrAddModeLock(value: string): boolean {
  if (value === '') return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x3a /* ':' */ || code === 0xff1a /* '：' */) {
      return true;
    }
  }
  const parsed = parseQuickAdd(value);
  return parsed.mode === 'add' || parsed.mode === 'add-invalid';
}

export function isSingleLineValue(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0a /* \n */ || code === 0x0d /* \r */) {
      return false;
    }
  }
  return true;
}

export function isHashTagModeValue(value: string): boolean {
  let i = 0;
  while (i < value.length) {
    const cp = value.codePointAt(i);
    if (cp === undefined) return false;
    if (!isUnicodeWhiteSpace(cp)) {
      return cp === 0x23; /* '#' */
    }
    i += cp > 0xffff ? 2 : 1;
  }
  return false;
}

export interface ExtractedTagModeToken {
  readonly isTagMode: boolean;
  /** Token between leading `#` and the first whitespace or `:`/`：` (empty when lone `#`). */
  readonly token: string;
  readonly withinRuneLimit: boolean;
}

/**
 * Extracts the `#` mode token between the leading `#` and the first whitespace or colon (`:` / `：`).
 * Note: SPEC §3.5 rules 3 & 5 state that if any `:`/`：` is present in the draft, the colon lock
 * prevents sending altogether; this helper also stops at `:`/`：` as a defense-in-depth bound.
 */
export function extractTagModeToken(value: string): ExtractedTagModeToken {
  let i = 0;
  const len = value.length;
  while (i < len) {
    const cp = value.codePointAt(i);
    if (cp === undefined || !isUnicodeWhiteSpace(cp)) {
      break;
    }
    i += cp > 0xffff ? 2 : 1;
  }

  if (i >= len || value.codePointAt(i) !== 0x23 /* '#' */) {
    return { isTagMode: false, token: '', withinRuneLimit: false };
  }

  // Advance past '#'
  i += 1;

  // Extract only the token between '#' and the first whitespace or ':' / '：' (SPEC §3.5 rule 5).
  let end = i;
  while (end < len) {
    const cp = value.codePointAt(end);
    if (
      cp === undefined ||
      isUnicodeWhiteSpace(cp) ||
      cp === 0x3a /* ':' */ ||
      cp === 0xff1a /* '：' */
    ) {
      break;
    }
    end += cp > 0xffff ? 2 : 1;
  }

  const token = value.slice(i, end);
  const withinRuneLimit = countRunes(token, TAG_QUERY_MAX_RUNES) <= TAG_QUERY_MAX_RUNES;
  return {
    isTagMode: true,
    token,
    withinRuneLimit,
  };
}

/**
 * Computes the common prefix length and common suffix length between `prev` and `next`,
 * returning the deleted slice of `prev` and the inserted slice of `next` for a single contiguous edit.
 */
function computeSingleSpliceDiff(
  prev: string,
  next: string,
): { readonly deleted: string; readonly inserted: string } {
  let prefixLen = 0;
  const minLen = Math.min(prev.length, next.length);
  while (prefixLen < minLen && prev.charCodeAt(prefixLen) === next.charCodeAt(prefixLen)) {
    prefixLen += 1;
  }

  let prevSuffixStart = prev.length;
  let nextSuffixStart = next.length;
  while (
    prevSuffixStart > prefixLen &&
    nextSuffixStart > prefixLen &&
    prev.charCodeAt(prevSuffixStart - 1) === next.charCodeAt(nextSuffixStart - 1)
  ) {
    prevSuffixStart -= 1;
    nextSuffixStart -= 1;
  }

  return {
    deleted: prev.slice(prefixLen, prevSuffixStart),
    inserted: next.slice(prefixLen, nextSuffixStart),
  };
}

export interface SendGateInputStepParams {
  readonly inputType?: string | null;
  readonly data?: string | null;
  readonly isComposing?: boolean;
  /** Optional explicit `prevValue` override for stateless callers; stateful gate uses its own `prevValue`. */
  readonly prevValue?: string;
  readonly value: string;
}

export interface SendGateState {
  readonly value: string;
  readonly prevValue: string;
  readonly tainted: boolean;
  readonly colonLocked: boolean;
  readonly isComposing: boolean;
  /** Value at `compositionstart` to measure total committed graphemes on `compositionend`. */
  readonly compositionStartValue: string | null;
  /** Incremented or flagged when `compositionend` commits cleanly so the caller restarts the 120ms debounce. */
  readonly restartDebounceSignal: number;
}

export interface SemanticEligibilityContext {
  readonly semanticAvailable?: boolean;
  readonly semanticSuggest?: boolean;
  readonly scope?: SearchScope;
  readonly cursor?: string | null;
}

export type GateBlockReason =
  | 'tainted'
  | 'colon_locked'
  | 'composing'
  | 'multiline'
  | 'too_long'
  | 'invalid_query'
  | 'empty_normalized';

export interface KeystrokeSendDecision {
  /** Whether the gate is currently open and a `/suggest` request may be sent after debounce. */
  readonly canSend: boolean;
  /** Whether the gate is closed in a way that requires clearing the server snapshot (SPEC §3.5 rule 11, 2.24 item 2/10). */
  readonly gateClosed: boolean;
  /** Whether local cached tag rows in `#` mode should be kept when `gateClosed` is true (2.24 item 10). */
  readonly keepLocalTagCacheRows: boolean;
  /** Reason when `canSend` is false. */
  readonly blockReason: GateBlockReason | null;
  /** Query string `q` to send (`undefined` in `recent` mode when field is empty). */
  readonly q: string | undefined;
  /** Normalized query `qn` (`''` in `recent` mode or when normalized empty). */
  readonly qn: string;
  readonly scope: SearchScope;
  readonly mode: SuggestMode;
  /** Whether `semantic=1` is allowed alongside `semantic=0` for this keystroke tick. */
  readonly allowSemantic: boolean;
  /** Semantic flags to issue in parallel on this debounce tick (`[0, 1]` when hybrid, `[0]` when lexical-only, `[]` when blocked). */
  readonly semanticFlags: readonly SemanticParam[];
  readonly requestMode: SearchRequestMode;
  readonly restartDebounceSignal: number;
}

export interface EnterSearchDecision {
  /** Whether Enter without an active row should call `GET /search` (`false` if add mode, multi-line, > 200 runes, or normalized-empty `q`). */
  readonly canSearch: boolean;
  /** True when `q` normalizes to empty (`"!!!"`, lone `"#"`), meaning UI shows local no-match without calling `/search` (plan 2.9, FE-17). */
  readonly isLocalEmptyMatch: boolean;
  readonly blockReason: GateBlockReason | null;
  readonly q: string;
  readonly qn: string;
  readonly scope: SearchScope;
  /** `semantic` query param for `GET /search`: `1` ONLY if draft is gate-clean and satisfies rule 7; `0` when gate is closed or `#` mode (2.24 items 1, 8, 9). */
  readonly semantic: SemanticParam;
  readonly requestMode: SearchRequestMode;
}

export interface ReissueSemanticDecision {
  /** Whether a request with `semantic=1` (e.g. on toggle ≈ on) may be sent for the current draft (2.24 item 8). */
  readonly canSendSemantic: boolean;
  readonly semantic: SemanticParam;
  readonly q: string | undefined;
  readonly qn: string;
  readonly scope: SearchScope;
}

export type OmniboxHelpTextKey =
  | 'search.help.sentToServer'
  | 'search.help.sentToServerExternal'
  | 'search.help.enterToSearch'
  | 'content.omnibox.tagHint'
  | 'content.privacy';

export function createInitialSendGateState(initialValue = ''): SendGateState {
  const colonLocked = hasColonOrAddModeLock(initialValue);
  return {
    value: initialValue,
    prevValue: initialValue,
    tainted: false,
    colonLocked,
    isComposing: false,
    compositionStartValue: null,
    restartDebounceSignal: 0,
  };
}

/**
 * Evaluates a single native input event step against the prior `SendGateState`.
 * Pure state transition function usable both standalone and inside `createSendGate()`.
 */
export function stepSendGateInput(
  state: SendGateState,
  event: SendGateInputStepParams,
): SendGateState {
  // Ensure Intl.Segmenter is checked early so missing support fails loudly.
  getGraphemeSegmenter();

  const nextValue = event.value;
  if (nextValue === '') {
    return {
      value: '',
      prevValue: '',
      tainted: false,
      colonLocked: false,
      isComposing: Boolean(event.isComposing),
      compositionStartValue: event.isComposing ? '' : null,
      restartDebounceSignal: state.restartDebounceSignal,
    };
  }

  const prevValue = event.prevValue !== undefined ? event.prevValue : state.prevValue;
  const colonLocked = state.colonLocked || hasColonOrAddModeLock(nextValue) || hasColonOrAddModeLock(prevValue);
  const inputType = event.inputType ?? '';
  const isComposing =
    Boolean(event.isComposing) ||
    state.isComposing ||
    Object.prototype.hasOwnProperty.call(COMPOSITION_INPUT_TYPES, inputType);

  let tainted = state.tainted;

  // Rule 1(c): missing `inputType` (e.g. synthetic `new Event('input')` or Safari autofill) -> taint.
  if (!inputType) {
    tainted = true;
  } else if (!Object.prototype.hasOwnProperty.call(ALLOWED_INPUT_TYPES, inputType)) {
    // Rule 1(b): inputType outside allowlist (insertFromPaste, insertFromDrop, insertReplacementText,
    // historyUndo, historyRedo, insertLineBreak, insertParagraph, etc.) -> taint.
    tainted = true;
  } else {
    const diff = computeSingleSpliceDiff(prevValue, nextValue);
    const isDeleteOp = Object.prototype.hasOwnProperty.call(DELETE_INPUT_TYPES, inputType);
    if (isDeleteOp) {
      // A delete operation must not insert characters and must delete at least 1 code unit
      // (unless prevValue === nextValue). If characters were inserted, a foreign write occurred (rule 1(d)).
      if (diff.inserted.length > 0) {
        tainted = true;
      }
    } else if (!isComposing) {
      // Rule 1(a) & 1(d) outside composition (`insertText`):
      // Verify that `nextValue` matches `prevValue` + the event's own edit, and inserted graphemes <= 1.
      const inserted = diff.inserted;
      if (event.data !== undefined && event.data !== null && inserted !== event.data) {
        tainted = true;
      }
      if (countGraphemes(inserted, 1) > 1) {
        tainted = true;
      }
      // If event.data was provided, also check its grapheme count directly (e.g. beforeinput where value hasn't mutated yet).
      if (event.data !== undefined && event.data !== null && countGraphemes(event.data, 1) > 1) {
        tainted = true;
      }
      // If `nextValue === prevValue` and `event.data` is empty/absent on an `input` event, nothing changed;
      // if `nextValue !== prevValue` and `inserted === ''` on `insertText`, that's a deletion or foreign mutation.
      if (nextValue !== prevValue && inserted === '') {
        tainted = true;
      }
    } else {
      // Inside composition (`insertCompositionText`, `insertFromComposition`):
      // Check against the 64-grapheme commit ceiling (FE-24) on the active composition span or inserted text.
      const baseValue = state.compositionStartValue ?? prevValue;
      const compDiff = computeSingleSpliceDiff(baseValue, nextValue);
      if (countGraphemes(compDiff.inserted, COMPOSITION_COMMIT_MAX_GRAPHEMES) > COMPOSITION_COMMIT_MAX_GRAPHEMES) {
        tainted = true;
      }
      if (
        event.data !== undefined &&
        event.data !== null &&
        countGraphemes(event.data, COMPOSITION_COMMIT_MAX_GRAPHEMES) > COMPOSITION_COMMIT_MAX_GRAPHEMES
      ) {
        tainted = true;
      }
    }
  }

  if (!isSingleLineValue(nextValue)) {
    tainted = true;
  }

  return {
    value: nextValue,
    prevValue: nextValue,
    tainted,
    colonLocked,
    isComposing: Boolean(event.isComposing),
    compositionStartValue: state.compositionStartValue,
    restartDebounceSignal: state.restartDebounceSignal,
  };
}

/**
 * Handles `beforeinput` native event before DOM value mutation.
 * Checks allowlist and multi-grapheme `data` outside composition without advancing `prevValue`.
 */
export function stepSendGateBeforeInput(
  state: SendGateState,
  event: {
    readonly inputType?: string | null;
    readonly data?: string | null;
    readonly isComposing?: boolean;
    readonly currentDomValue?: string;
  },
): SendGateState {
  getGraphemeSegmenter();

  let tainted = state.tainted;
  let colonLocked = state.colonLocked;

  // Rule 1(d): if the live DOM value before this input event already diverged from `state.prevValue`
  // without going through `syncOwnWrite`, a foreign programmatic `.value` assignment happened.
  if (event.currentDomValue !== undefined && event.currentDomValue !== state.prevValue) {
    tainted = true;
    if (hasColonOrAddModeLock(event.currentDomValue)) {
      colonLocked = true;
    }
  }
  const inputType = event.inputType ?? '';
  const isComposing =
    Boolean(event.isComposing) ||
    state.isComposing ||
    Object.prototype.hasOwnProperty.call(COMPOSITION_INPUT_TYPES, inputType);

  if (!inputType || !Object.prototype.hasOwnProperty.call(ALLOWED_INPUT_TYPES, inputType)) {
    tainted = true;
  } else if (!isComposing && inputType === 'insertText') {
    const data = event.data ?? '';
    if (countGraphemes(data, 1) > 1) {
      tainted = true;
    }
    if (hasColonOrAddModeLock(data)) {
      colonLocked = true;
    }
  } else if (isComposing && event.data) {
    if (countGraphemes(event.data, COMPOSITION_COMMIT_MAX_GRAPHEMES) > COMPOSITION_COMMIT_MAX_GRAPHEMES) {
      tainted = true;
    }
    if (hasColonOrAddModeLock(event.data)) {
      colonLocked = true;
    }
  }

  return {
    ...state,
    tainted,
    colonLocked,
    isComposing: Boolean(event.isComposing) || state.isComposing,
  };
}

/**
 * Handles `compositionstart` native event (plan mục 2.1 rule 2).
 */
export function stepSendGateCompositionStart(
  state: SendGateState,
  currentValue?: string,
): SendGateState {
  const val = currentValue !== undefined ? currentValue : state.value;
  const foreignChanged = val !== state.prevValue;
  return {
    ...state,
    value: val,
    prevValue: val,
    tainted: state.tainted || foreignChanged,
    colonLocked: state.colonLocked || hasColonOrAddModeLock(val),
    isComposing: true,
    compositionStartValue: val,
  };
}

/**
 * Handles `compositionend` native event (plan mục 2.1 rule 2, FE-24):
 * - Committed text counts as typed unless the commit inserted > 64 graphemes (which taints).
 * - Colon check still applies to committed text.
 * - Increments `restartDebounceSignal` so the 120ms debounce restarts after `compositionend`.
 */
export function stepSendGateCompositionEnd(
  state: SendGateState,
  params: { readonly value: string; readonly data?: string | null },
): SendGateState {
  getGraphemeSegmenter();

  const nextValue = params.value;
  if (nextValue === '') {
    return {
      value: '',
      prevValue: '',
      tainted: false,
      colonLocked: false,
      isComposing: false,
      compositionStartValue: null,
      restartDebounceSignal: state.restartDebounceSignal + 1,
    };
  }

  const baseValue = state.compositionStartValue ?? state.prevValue;
  const diff = computeSingleSpliceDiff(baseValue, nextValue);
  let tainted = state.tainted;

  if (countGraphemes(diff.inserted, COMPOSITION_COMMIT_MAX_GRAPHEMES) > COMPOSITION_COMMIT_MAX_GRAPHEMES) {
    tainted = true;
  }
  if (
    params.data !== undefined &&
    params.data !== null &&
    countGraphemes(params.data, COMPOSITION_COMMIT_MAX_GRAPHEMES) > COMPOSITION_COMMIT_MAX_GRAPHEMES
  ) {
    tainted = true;
  }
  if (!isSingleLineValue(nextValue)) {
    tainted = true;
  }

  const colonLocked = state.colonLocked || hasColonOrAddModeLock(nextValue);

  return {
    value: nextValue,
    prevValue: nextValue,
    tainted,
    colonLocked,
    isComposing: false,
    compositionStartValue: null,
    restartDebounceSignal: state.restartDebounceSignal + 1,
  };
}

/**
 * Synchronizes omnibox's own programmatic write (`setDraft(value)` — plan mục 2.1 rule 1 & 3, M4/FE-21, SPEC §3.5 rule 3):
 * - Sets `prevValue = value` and `value = value`.
 * - Preserves `tainted` (`false` if it was `false`, `true` if it was `true`), clearing `tainted` ONLY when `value === ''`.
 * - Evaluates colon/add-mode lock on `value` (so `syncOwnWrite('name: body')`, `syncOwnWrite('http://x')`, or Tab-fill `name: `
 *   locks immediately until the field becomes `''`; `syncOwnWrite('')` clears `colonLocked`).
 */
export function syncSendGateOwnWrite(
  state: SendGateState,
  value: string,
): SendGateState {
  if (value === '') {
    return {
      value: '',
      prevValue: '',
      tainted: false,
      colonLocked: false,
      isComposing: false,
      compositionStartValue: null,
      restartDebounceSignal: state.restartDebounceSignal,
    };
  }

  const colonLocked = state.colonLocked || hasColonOrAddModeLock(value);
  const tainted = state.tainted || !isSingleLineValue(value);

  return {
    ...state,
    value,
    prevValue: value,
    tainted,
    colonLocked,
  };
}

/**
 * Resets the gate on vault lock, logout, or user switch (plan mục 2.1 rule 8).
 */
export function resetSendGateState(): SendGateState {
  return createInitialSendGateState('');
}

/**
 * Reconciles `state` with the current `draftValue` at evaluation time:
 * if `draftValue !== state.prevValue`, a foreign programmatic write occurred without `syncOwnWrite` (rule 1(d)).
 */
function reconcileObservedValue(
  state: SendGateState,
  draftValue?: string,
): SendGateState {
  if (draftValue === undefined || draftValue === state.value) {
    return state;
  }
  if (draftValue === '') {
    return {
      ...state,
      value: '',
      prevValue: '',
      tainted: false,
      colonLocked: false,
    };
  }
  return {
    ...state,
    value: draftValue,
    tainted: true,
    colonLocked: state.colonLocked || hasColonOrAddModeLock(draftValue),
  };
}

/**
 * Evaluates whether a keystroke `/suggest` request may be sent for the current gate state,
 * and with which `{ q, scope, semanticFlags, requestMode }` (plan mục 2.1, 2.24 items 1, 2, 8, 9, 10; SPEC §3.5 rules 1–11).
 */
export function evaluateKeystrokeSend(
  rawState: SendGateState,
  context: SemanticEligibilityContext = {},
  currentValue?: string,
): KeystrokeSendDecision {
  const state = reconcileObservedValue(rawState, currentValue);
  const value = state.value;
  const inTagMode = isHashTagModeValue(value);

  // Rule 3: Colon lock (or add/add-invalid mode) blocks all keystroke sends until empty.
  if (state.colonLocked || hasColonOrAddModeLock(value)) {
    return {
      canSend: false,
      gateClosed: true,
      keepLocalTagCacheRows: inTagMode,
      blockReason: 'colon_locked',
      q: undefined,
      qn: '',
      scope: inTagMode ? 'tag' : (context.scope ?? 'all'),
      mode: 'prefix',
      allowSemantic: false,
      semanticFlags: [],
      requestMode: 'lex',
      restartDebounceSignal: state.restartDebounceSignal,
    };
  }

  // Rule 1: Tainted draft blocks all keystroke sends until empty.
  if (state.tainted) {
    return {
      canSend: false,
      gateClosed: true,
      keepLocalTagCacheRows: inTagMode,
      blockReason: 'tainted',
      q: undefined,
      qn: '',
      scope: inTagMode ? 'tag' : (context.scope ?? 'all'),
      mode: 'prefix',
      allowSemantic: false,
      semanticFlags: [],
      requestMode: 'lex',
      restartDebounceSignal: state.restartDebounceSignal,
    };
  }

  // Rule 4: Multi-line draft never sends.
  if (!isSingleLineValue(value)) {
    return {
      canSend: false,
      gateClosed: true,
      keepLocalTagCacheRows: inTagMode,
      blockReason: 'multiline',
      q: undefined,
      qn: '',
      scope: inTagMode ? 'tag' : (context.scope ?? 'all'),
      mode: 'prefix',
      allowSemantic: false,
      semanticFlags: [],
      requestMode: 'lex',
      restartDebounceSignal: state.restartDebounceSignal,
    };
  }

  // Rule 2: While IME composing, hold off sending (keep current rows, do not close gate).
  if (state.isComposing) {
    return {
      canSend: false,
      gateClosed: false,
      keepLocalTagCacheRows: inTagMode,
      blockReason: 'composing',
      q: undefined,
      qn: '',
      scope: inTagMode ? 'tag' : (context.scope ?? 'all'),
      mode: 'prefix',
      allowSemantic: false,
      semanticFlags: [],
      requestMode: 'lex',
      restartDebounceSignal: state.restartDebounceSignal,
    };
  }

  // Rule 6: Empty or whitespace-only field -> recent mode (`GET /suggest` without `q`, always `semantic=0`).
  const trimmed = trimUnicodeWhiteSpace(value);
  if (trimmed === '') {
    const scope: SearchScope = context.scope ?? 'all';
    return {
      canSend: true,
      gateClosed: false,
      keepLocalTagCacheRows: false,
      blockReason: null,
      q: undefined,
      qn: '',
      scope,
      mode: 'recent',
      allowSemantic: false,
      semanticFlags: [0],
      requestMode: 'lex',
      restartDebounceSignal: state.restartDebounceSignal,
    };
  }

  // Rule 5 & 2.24 item 9: `#` mode -> extract token up to first whitespace or `:`, `scope='tag'`, ALWAYS `semantic=0`.
  if (inTagMode) {
    const extracted = extractTagModeToken(value);
    if (!extracted.withinRuneLimit) {
      return {
        canSend: false,
        gateClosed: true,
        keepLocalTagCacheRows: true,
        blockReason: 'too_long',
        q: undefined,
        qn: '',
        scope: 'tag',
        mode: 'prefix',
        allowSemantic: false,
        semanticFlags: [],
        requestMode: 'lex',
        restartDebounceSignal: state.restartDebounceSignal,
      };
    }

    // Lone `#` (empty token) sends `q: '#'` (server maps `#` alone to 200 empty prefix, SPEC §2.2);
    // non-empty token sends only the extracted token (never text after whitespace).
    const qToSend = extracted.token === '' ? '#' : extracted.token;
    const normTag = normalizeTagQuery(extracted.token);
    if (!normTag.ok) {
      return {
        canSend: false,
        gateClosed: true,
        keepLocalTagCacheRows: true,
        blockReason: 'invalid_query',
        q: undefined,
        qn: '',
        scope: 'tag',
        mode: 'prefix',
        allowSemantic: false,
        semanticFlags: [],
        requestMode: 'lex',
        restartDebounceSignal: state.restartDebounceSignal,
      };
    }
    const qn = normTag.normalized;
    const qnRunes = countRunes(qn);
    const mode: SuggestMode = qnRunes >= 2 ? 'full' : 'prefix';

    return {
      canSend: true,
      gateClosed: false,
      keepLocalTagCacheRows: true,
      blockReason: null,
      q: qToSend,
      qn,
      scope: 'tag',
      mode,
      allowSemantic: false,
      semanticFlags: [0],
      requestMode: 'lex',
      restartDebounceSignal: state.restartDebounceSignal,
    };
  }

  // Rule 4: Search mode <= 200 runes.
  if (countRunes(trimmed, QUERY_MAX_RUNES) > QUERY_MAX_RUNES) {
    return {
      canSend: false,
      gateClosed: true,
      keepLocalTagCacheRows: false,
      blockReason: 'too_long',
      q: undefined,
      qn: '',
      scope: context.scope ?? 'all',
      mode: 'prefix',
      allowSemantic: false,
      semanticFlags: [],
      requestMode: 'lex',
      restartDebounceSignal: state.restartDebounceSignal,
    };
  }

  const norm = normalizeQuery(trimmed);
  if (!norm.ok) {
    return {
      canSend: false,
      gateClosed: true,
      keepLocalTagCacheRows: false,
      blockReason: 'invalid_query',
      q: undefined,
      qn: '',
      scope: context.scope ?? 'all',
      mode: 'prefix',
      allowSemantic: false,
      semanticFlags: [],
      requestMode: 'lex',
      restartDebounceSignal: state.restartDebounceSignal,
    };
  }

  const qn = norm.normalized;
  const qnRunes = countRunes(qn);
  const mode: SuggestMode = qnRunes >= 2 ? 'full' : 'prefix';
  const scope: SearchScope = context.scope ?? 'all';

  // SPEC §3.5 rule 7 + rule 10 + 2.24 items 8 & 9:
  // `semantic=1` ONLY when gate-clean AND `semantic_available && semantic_suggest && len_runes(qn) >= 3 && mode !== 'recent' && scope !== 'tag'`.
  const allowSemantic =
    Boolean(context.semanticAvailable) &&
    Boolean(context.semanticSuggest) &&
    scope !== 'tag' &&
    qnRunes >= SEMANTIC_MIN_QUERY_RUNES;

  return {
    canSend: true,
    gateClosed: false,
    keepLocalTagCacheRows: false,
    blockReason: null,
    q: trimmed,
    qn,
    scope,
    mode,
    allowSemantic,
    semanticFlags: allowSemantic ? [0, 1] : [0],
    requestMode: allowSemantic ? 'hybrid' : 'lex',
    restartDebounceSignal: state.restartDebounceSignal,
  };
}

/**
 * Evaluates Enter-search (`GET /search`) when no suggestion row is active
 * per plan mục 2.9, mục 2.24 items 1, 8, 9, and SPEC §3.4, §3.5 rules 7 & 10.
 *
 * Key security ruling (2.24 item 1):
 * - If the draft is NOT clean through the keystroke send-gate (tainted/pasted, colon-locked such as `http://x`
 *   or `wifi： mật khẩu`, or `#` mode), Enter-search MUST send `semantic=0` (lexical only, never external embedding provider).
 * - If the draft is multi-line, > 200 runes (> 50 runes in `#` mode), or `add`/`add-invalid` mode, `/search` is not called.
 * - If `q` normalizes to empty (`"!!!"`, lone `"#"`), `canSearch` is `false` and `isLocalEmptyMatch` is `true`
 *   so the caller shows local "Không khớp" without calling `/search` (FE-17).
 */
export function evaluateEnterSearch(
  rawState: SendGateState,
  context: SemanticEligibilityContext = {},
  currentValue?: string,
): EnterSearchDecision {
  const state = reconcileObservedValue(rawState, currentValue);
  const value = state.value;

  // Quick-add (`name: body`) or invalid quick-add goes to the add-mode Enter flow, never `/search`.
  const quickAdd = parseQuickAdd(value);
  if (quickAdd.mode === 'add' || quickAdd.mode === 'add-invalid') {
    return {
      canSearch: false,
      isLocalEmptyMatch: false,
      blockReason: 'colon_locked',
      q: '',
      qn: '',
      scope: 'all',
      semantic: 0,
      requestMode: 'lex',
    };
  }

  if (!isSingleLineValue(value)) {
    return {
      canSearch: false,
      isLocalEmptyMatch: false,
      blockReason: 'multiline',
      q: '',
      qn: '',
      scope: 'all',
      semantic: 0,
      requestMode: 'lex',
    };
  }

  const trimmed = trimUnicodeWhiteSpace(value);
  if (trimmed === '') {
    return {
      canSearch: false,
      isLocalEmptyMatch: false,
      blockReason: 'empty_normalized',
      q: '',
      qn: '',
      scope: context.scope ?? 'all',
      semantic: 0,
      requestMode: 'lex',
    };
  }

  const inTagMode = isHashTagModeValue(value);
  if (inTagMode) {
    // SPEC §3.5 rules 3 & 7 (FE-1, FE-C23): Enter-search from `#` mode sends `scope='tag'&semantic=0`
    // and never sends anything if the draft contains `:` or `：`.
    if (hasColonOrAddModeLock(value)) {
      return {
        canSearch: false,
        isLocalEmptyMatch: false,
        blockReason: 'colon_locked',
        q: '',
        qn: '',
        scope: 'tag',
        semantic: 0,
        requestMode: 'lex',
      };
    }

    const extracted = extractTagModeToken(value);
    if (!extracted.withinRuneLimit) {
      return {
        canSearch: false,
        isLocalEmptyMatch: false,
        blockReason: 'too_long',
        q: '',
        qn: '',
        scope: 'tag',
        semantic: 0,
        requestMode: 'lex',
      };
    }
    const normTag = normalizeTagQuery(extracted.token);
    if (!normTag.ok) {
      return {
        canSearch: false,
        isLocalEmptyMatch: false,
        blockReason: 'invalid_query',
        q: '',
        qn: '',
        scope: 'tag',
        semantic: 0,
        requestMode: 'lex',
      };
    }
    if (normTag.normalized === '') {
      return {
        canSearch: false,
        isLocalEmptyMatch: true,
        blockReason: 'empty_normalized',
        q: '',
        qn: '',
        scope: 'tag',
        semantic: 0,
        requestMode: 'lex',
      };
    }
    return {
      canSearch: true,
      isLocalEmptyMatch: false,
      blockReason: null,
      q: extracted.token,
      qn: normTag.normalized,
      scope: 'tag',
      semantic: 0,
      requestMode: 'lex',
    };
  }

  if (countRunes(trimmed, QUERY_MAX_RUNES) > QUERY_MAX_RUNES) {
    return {
      canSearch: false,
      isLocalEmptyMatch: false,
      blockReason: 'too_long',
      q: '',
      qn: '',
      scope: context.scope ?? 'all',
      semantic: 0,
      requestMode: 'lex',
    };
  }

  const norm = normalizeQuery(trimmed);
  if (!norm.ok) {
    return {
      canSearch: false,
      isLocalEmptyMatch: false,
      blockReason: 'invalid_query',
      q: '',
      qn: '',
      scope: context.scope ?? 'all',
      semantic: 0,
      requestMode: 'lex',
    };
  }

  if (norm.normalized === '') {
    return {
      canSearch: false,
      isLocalEmptyMatch: true,
      blockReason: 'empty_normalized',
      q: '',
      qn: '',
      scope: context.scope ?? 'all',
      semantic: 0,
      requestMode: 'lex',
    };
  }

  const scope: SearchScope = context.scope ?? 'all';
  const hasCursor = Boolean(context.cursor && context.cursor !== '');
  const gateClean =
    !state.tainted &&
    !state.colonLocked &&
    !hasColonOrAddModeLock(value) &&
    !state.isComposing;

  const qnRunes = countRunes(norm.normalized);
  const allowSemantic =
    gateClean &&
    !hasCursor &&
    scope !== 'tag' &&
    Boolean(context.semanticAvailable) &&
    Boolean(context.semanticSuggest) &&
    qnRunes >= SEMANTIC_MIN_QUERY_RUNES;

  return {
    canSearch: true,
    isLocalEmptyMatch: false,
    blockReason: null,
    q: trimmed,
    qn: norm.normalized,
    scope,
    semantic: allowSemantic ? 1 : 0,
    requestMode: allowSemantic ? 'hybrid' : 'lex',
  };
}

/**
 * Evaluates whether a follow-up request (e.g. toggling `≈` on, or retrying after `Retry-After`)
 * may send `semantic=1` for the current draft (plan mục 2.24 item 8, SPEC §3.5 rule 10, §6.8).
 *
 * When the user toggles `≈` ON while the current draft is unclean (e.g. pasted -> Enter -> click `≈`),
 * only `PATCH /me/settings` runs and `canSendSemantic` is `false` (no request is sent for the current query).
 */
export function evaluateSemanticReissue(
  rawState: SendGateState,
  context: SemanticEligibilityContext = {},
  currentValue?: string,
): ReissueSemanticDecision {
  const keystroke = evaluateKeystrokeSend(rawState, context, currentValue);
  const hasCursor = Boolean(context.cursor && context.cursor !== '');
  const canSendSemantic = keystroke.canSend && keystroke.allowSemantic && !hasCursor;
  return {
    canSendSemantic,
    semantic: canSendSemantic ? 1 : 0,
    q: canSendSemantic ? keystroke.q : undefined,
    qn: canSendSemantic ? keystroke.qn : '',
    scope: keystroke.scope,
  };
}

/**
 * Evaluates the `semantic` parameter for a "See more" (`cursor`) page of `GET /search`
 * (plan mục 2.24 item 8, SPEC §3.5 rule 10, §6.8): cursor pages ALWAYS send `semantic=0`.
 */
export function evaluateSeeMoreSearchSemantic(): SemanticParam {
  return 0;
}

/**
 * Resolves the omnibox help-text i18n key per SPEC §3.4 table and plan mục 2.1 rule 9 / 2.24 item 4:
 * - Add mode (`name: ...`) -> `'content.privacy'`
 * - Tainted, colon-locked outside add mode (`http://x`, `wifi： mật khẩu`, `#home:x`), multi-line, or > max runes
 *   -> `'search.help.enterToSearch'`
 * - `#` tag mode with open gate -> `'content.omnibox.tagHint'`
 * - Search mode with open gate -> `'search.help.sentToServerExternal'` when `semanticExternal` is `true` or `undefined`
 *   (fail-safe: absent = true, 2.24 item 4), or `'search.help.sentToServer'` when `semanticExternal === false`.
 */
export function resolveOmniboxHelpTextKey(
  rawState: SendGateState,
  opts: { readonly semanticExternal?: boolean | null; readonly currentValue?: string } = {},
): OmniboxHelpTextKey {
  const state = reconcileObservedValue(rawState, opts.currentValue);
  const value = state.value;
  const parsed = parseQuickAdd(value);

  if (parsed.mode === 'add' || parsed.mode === 'add-invalid') {
    return 'content.privacy';
  }

  const inTagMode = isHashTagModeValue(value);
  const isOversized = inTagMode
    ? !extractTagModeToken(value).withinRuneLimit
    : countRunes(trimUnicodeWhiteSpace(value), QUERY_MAX_RUNES) > QUERY_MAX_RUNES;

  if (
    state.tainted ||
    state.colonLocked ||
    hasColonOrAddModeLock(value) ||
    !isSingleLineValue(value) ||
    isOversized
  ) {
    return 'search.help.enterToSearch';
  }

  if (inTagMode) {
    return 'content.omnibox.tagHint';
  }

  // 2.24 item 4: absent (`undefined` or `null`) defaults to `true` (external provider fail-safe).
  const isExternal = opts.semanticExternal ?? true;
  return isExternal ? 'search.help.sentToServerExternal' : 'search.help.sentToServer';
}

export interface SendGateController {
  getState(): SendGateState;
  handleBeforeInput(event: {
    readonly inputType?: string | null;
    readonly data?: string | null;
    readonly isComposing?: boolean;
    readonly currentDomValue?: string;
  }): SendGateState;
  handleInput(event: SendGateInputStepParams): SendGateState;
  handleCompositionStart(currentValue?: string): SendGateState;
  handleCompositionEnd(params: { readonly value: string; readonly data?: string | null }): SendGateState;
  syncOwnWrite(value: string): SendGateState;
  reset(): SendGateState;
  decideKeystroke(context?: SemanticEligibilityContext, currentValue?: string): KeystrokeSendDecision;
  decideEnterSearch(context?: SemanticEligibilityContext, currentValue?: string): EnterSearchDecision;
  decideSemanticReissue(context?: SemanticEligibilityContext, currentValue?: string): ReissueSemanticDecision;
  decideSeeMoreSemantic(): SemanticParam;
  getHelpTextKey(opts?: { readonly semanticExternal?: boolean | null; readonly currentValue?: string }): OmniboxHelpTextKey;
}

/**
 * Stateful send-gate instance wrapping the pure transition functions for convenient wiring
 * to native textarea listeners (`beforeinput`, `input`, `compositionstart`, `compositionend`),
 * `syncOwnWrite(value)`, and `reset()`.
 */
export function createSendGate(initialValue = ''): SendGateController {
  getGraphemeSegmenter();
  let state = createInitialSendGateState(initialValue);

  return {
    getState() {
      return state;
    },
    handleBeforeInput(event) {
      state = stepSendGateBeforeInput(state, event);
      return state;
    },
    handleInput(event) {
      state = stepSendGateInput(state, event);
      return state;
    },
    handleCompositionStart(currentValue) {
      state = stepSendGateCompositionStart(state, currentValue);
      return state;
    },
    handleCompositionEnd(params) {
      state = stepSendGateCompositionEnd(state, params);
      return state;
    },
    syncOwnWrite(value) {
      state = syncSendGateOwnWrite(state, value);
      return state;
    },
    reset() {
      state = resetSendGateState();
      return state;
    },
    decideKeystroke(context, currentValue) {
      state = reconcileObservedValue(state, currentValue);
      return evaluateKeystrokeSend(state, context);
    },
    decideEnterSearch(context, currentValue) {
      state = reconcileObservedValue(state, currentValue);
      return evaluateEnterSearch(state, context);
    },
    decideSemanticReissue(context, currentValue) {
      state = reconcileObservedValue(state, currentValue);
      return evaluateSemanticReissue(state, context);
    },
    decideSeeMoreSemantic() {
      return evaluateSeeMoreSearchSemantic();
    },
    getHelpTextKey(opts) {
      state = reconcileObservedValue(state, opts?.currentValue);
      return resolveOmniboxHelpTextKey(state, opts);
    },
  };
}
