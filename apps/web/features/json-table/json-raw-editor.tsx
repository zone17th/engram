'use client';

import { useFormatter, useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  ENTRY_MAX_PLAINTEXT_BYTES,
  ENTRY_NEAR_CAP_BYTES,
  VAULT_SECRET_INPUT_PROPS,
} from '@/features/entries';
import {
  JSON_FORMAT_MAX_DEPTH,
  detectEol,
  formatJsonStrict,
  isWellFormedUtf16,
  lineColumnToOffset,
  measureUtf8Bytes,
  parseJsonStrict,
  type EolAnalysis,
  type JsonErrorCode,
  type JsonParseError,
} from '@/lib/json';

export const RAW_PARSE_DEBOUNCE_MS = 180;

export interface RawValidationIssue {
  readonly kind: 'invalid_unicode' | 'over_cap' | 'parse_error';
  readonly parseError?: JsonParseError;
  readonly byteLength?: number;
}

export function validateRawJsonText(text: string): RawValidationIssue | null {
  if (!isWellFormedUtf16(text)) {
    return { kind: 'invalid_unicode' };
  }
  const byteLength = measureUtf8Bytes(text);
  if (byteLength > ENTRY_MAX_PLAINTEXT_BYTES) {
    return { kind: 'over_cap', byteLength };
  }
  const parsed = parseJsonStrict(text);
  if (!parsed.ok) {
    return {
      kind: 'parse_error',
      parseError: parsed.error,
      byteLength,
    };
  }
  return null;
}

export interface JsonRawEditorProps {
  readonly entryId: string;
  readonly positionNumber: number;
  readonly draftValue: string;
  readonly sourceEol: EolAnalysis;
  readonly prospectiveByteLength: number;
  readonly isOverCap: boolean;
  readonly isDirty: boolean;
  readonly savingInFlight: boolean;
  readonly hasBlockingState: boolean;
  readonly externalError?: string | null;
  readonly onDraftChange: (nextValue: string) => void;
  readonly onValidationSettled?: (issue: RawValidationIssue | null) => void;
  readonly onSave: () => void;
  readonly onRequestCancel?: () => void;
  readonly parseDebounceMs?: number;
}

export function JsonRawEditor({
  entryId,
  positionNumber,
  draftValue,
  sourceEol,
  prospectiveByteLength,
  isOverCap,
  isDirty,
  savingInFlight,
  hasBlockingState,
  externalError = null,
  onDraftChange,
  onValidationSettled,
  onSave,
  onRequestCancel,
  parseDebounceMs = RAW_PARSE_DEBOUNCE_MS,
}: JsonRawEditorProps) {
  const tJson = useTranslations('content.json');
  const tEntry = useTranslations('content.entry');
  const format = useFormatter();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pauseTimerRef = useRef<number | undefined>(undefined);

  // Parse-on-typing-pause state (SPEC §7.7, Task 16 item 4, IP16-FE1-7):
  // Do NOT run parseJsonStrict synchronously on every keystroke; validate only after the typing pause
  // (or immediately on initial mount, blur, Save, Format, or Ctrl+S).
  const [validatedState, setValidatedState] = useState<{
    readonly text: string;
    readonly issue: RawValidationIssue | null;
  }>(() => {
    const initialIssue = validateRawJsonText(draftValue);
    return { text: draftValue, issue: initialIssue };
  });
  const [formatErrorMsg, setFormatErrorMsg] = useState<string | null>(null);

  const onValidationSettledRef = useRef(onValidationSettled);
  onValidationSettledRef.current = onValidationSettled;

  useEffect(() => {
    onValidationSettledRef.current?.(validatedState.issue);
  }, [validatedState.issue]);

  useEffect(() => {
    if (validatedState.text === draftValue) {
      clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = undefined;
      return;
    }

    if (parseDebounceMs <= 0) {
      clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = undefined;
      const issue = validateRawJsonText(draftValue);
      setValidatedState({ text: draftValue, issue });
      return;
    }

    clearTimeout(pauseTimerRef.current);
    pauseTimerRef.current = window.setTimeout(() => {
      pauseTimerRef.current = undefined;
      const issue = validateRawJsonText(draftValue);
      setValidatedState({ text: draftValue, issue });
    }, parseDebounceMs);

    return () => {
      clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = undefined;
    };
  }, [draftValue, parseDebounceMs, validatedState.text]);

  const flushValidationImmediate = useCallback(() => {
    clearTimeout(pauseTimerRef.current);
    pauseTimerRef.current = undefined;
    const currentText = textareaRef.current?.value ?? draftValue;
    const currentIssue = validateRawJsonText(currentText);
    setValidatedState({ text: currentText, issue: currentIssue });
    onValidationSettledRef.current?.(currentIssue);
    return currentIssue;
  }, [draftValue]);

  const validationPending = validatedState.text !== draftValue;
  const debouncedIssue = validatedState.issue;

  const displayedIssue = useMemo<RawValidationIssue | null>(
    () =>
      isOverCap
        ? ({ kind: 'over_cap', byteLength: prospectiveByteLength } as const)
        : debouncedIssue,
    [debouncedIssue, isOverCap, prospectiveByteLength],
  );

  const isInvalid = validationPending || debouncedIssue !== null || isOverCap;
  const saveDisabled =
    isInvalid || savingInFlight || hasBlockingState || draftValue.length === 0;
  const formatDisabled =
    isInvalid || savingInFlight || hasBlockingState || draftValue.length === 0;
  const formattedBytes = useMemo(() => {
    try {
      return format.number(prospectiveByteLength);
    } catch {
      return String(prospectiveByteLength);
    }
  }, [format, prospectiveByteLength]);

  const isNearCap = !isOverCap && prospectiveByteLength >= ENTRY_NEAR_CAP_BYTES;

  const targetEolLabel =
    sourceEol.majority === 'crlf'
      ? 'CRLF'
      : sourceEol.majority === 'cr'
        ? 'CR'
        : 'LF';

  const translateParseErrorCode = useCallback(
    (code: JsonErrorCode): string => {
      return tJson(`parseError.${code}` as Parameters<typeof tJson>[0]);
    },
    [tJson],
  );

  const handleGoToError = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // IP16-FE1-15: Re-validate live textarea value immediately before jumping so line/column is never stale
    const issue = flushValidationImmediate();
    if (!issue || issue.kind !== 'parse_error' || !issue.parseError) return;

    const { line, column } = issue.parseError;
    const currentText = ta.value;
    const targetOffset = lineColumnToOffset(currentText, line, column);
    const clampedStart = Math.max(0, Math.min(targetOffset, currentText.length));

    // If the character at clampedStart is the high surrogate of a surrogate pair, select both code units
    let clampedEnd = Math.min(clampedStart + 1, currentText.length);
    if (clampedStart < currentText.length) {
      const code = currentText.charCodeAt(clampedStart);
      if (code >= 0xd800 && code <= 0xdbff && clampedStart + 1 < currentText.length) {
        const low = currentText.charCodeAt(clampedStart + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          clampedEnd = clampedStart + 2;
        }
      }
    }

    ta.focus();
    ta.setSelectionRange(clampedStart, clampedEnd);
  }, [flushValidationImmediate]);
  const handleFormat = useCallback(() => {
    setFormatErrorMsg(null);
    const immediateIssue = flushValidationImmediate();
    if (immediateIssue !== null || savingInFlight || hasBlockingState) return;
    const currentText = textareaRef.current?.value ?? draftValue;
    const eolInfo = detectEol(currentText);
    const targetEol = sourceEol.totalBreaks > 0 ? sourceEol.majority : eolInfo.majority;
    const res = formatJsonStrict(currentText, { eol: targetEol });

    if (!res.ok) {
      if (res.error.code === 'DEPTH_LIMIT_EXCEEDED') {
        setFormatErrorMsg(
          tJson('formatRefusedDepth', {
            maxDepth: res.error.maxDepth ?? JSON_FORMAT_MAX_DEPTH,
          }),
        );
      } else if (res.error.code === 'BYTE_LIMIT_EXCEEDED') {
        const byteStr = (() => {
          const b = res.error.byteLength ?? ENTRY_MAX_PLAINTEXT_BYTES + 1;
          try {
            return format.number(b);
          } catch {
            return String(b);
          }
        })();
        setFormatErrorMsg(tJson('formatRefusedBytes', { bytes: byteStr }));
      } else {
        setFormatErrorMsg(tJson('formatRefusedInvalid'));
      }
      return;
    }

    // Format rewrites the textarea draft (normalized to \n for HTML textarea); Save commits
    const normalizedFormatted = res.text.replace(/\r\n|\r/g, '\n');
    onDraftChange(normalizedFormatted);
    setValidatedState({ text: normalizedFormatted, issue: null });
  }, [
    draftValue,
    flushValidationImmediate,
    format,
    hasBlockingState,
    onDraftChange,
    savingInFlight,
    sourceEol.majority,
    sourceEol.totalBreaks,
    tJson,
  ]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const keyLower = (e.key || '').toLowerCase();
    if (keyLower === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      const immediateIssue = flushValidationImmediate();
      if (immediateIssue !== null || isOverCap || savingInFlight || hasBlockingState || draftValue.length === 0) return;
      onSave();
    } else if (e.key === 'Escape' && onRequestCancel) {
      e.preventDefault();
      e.stopPropagation();
      onRequestCancel();
    }
  };

  const errorBoxId = `json-raw-error-${entryId}`;
  const bytesCounterId = `json-raw-bytes-${entryId}`;

  return (
    <div
      id={`json-raw-panel-${entryId}`}
      data-testid={`json-raw-panel-${entryId}`}
      data-json-raw-interactive="1"
      className="bg-surface p-4"
    >
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            id={`json-raw-format-btn-${entryId}`}
            data-testid={`json-raw-format-btn-${entryId}`}
            data-json-raw-format=""
            disabled={formatDisabled}
            className="btn btn-secondary btn-sm"
            onClick={handleFormat}
          >
            {tJson('formatBtn')}
          </button>
          <button
            type="button"
            id={`json-raw-save-btn-${entryId}`}
            data-testid={`json-raw-save-btn-${entryId}`}
            data-json-raw-save=""
            disabled={saveDisabled}
            aria-busy={savingInFlight || undefined}
            className="btn btn-primary btn-sm"
            onClick={() => {
              const immediateIssue = flushValidationImmediate();
              if (immediateIssue !== null || isOverCap || savingInFlight || hasBlockingState || draftValue.length === 0) return;
              onSave();
            }}
          >
            {savingInFlight ? (
              tEntry('savingButton')
            ) : (
              <>
                {tJson('saveBtn')} (<span className="mono">Ctrl+S</span>)
              </>
            )}
          </button>
          {isDirty && onRequestCancel ? (
            <button
              type="button"
              id={`json-raw-cancel-btn-${entryId}`}
              data-testid={`json-raw-cancel-btn-${entryId}`}
              disabled={savingInFlight}
              className="btn btn-tertiary btn-sm"
              onClick={onRequestCancel}
            >
              {tJson('cancelBtn')} (<span className="mono">Esc</span>)
            </button>
          ) : null}
        </div>

        <span
          id={bytesCounterId}
          data-testid={`json-raw-bytes-${entryId}`}
          data-json-raw-bytes=""
          className={`mono text-[12px] ${
            isOverCap ? 'font-semibold text-error-ink' : 'text-muted'
          }`}
        >
          {isOverCap
            ? tEntry('byteCounterOver', { bytes: formattedBytes })
            : isNearCap
              ? tEntry('byteCounterNear', { bytes: formattedBytes })
              : tEntry('byteCounter', { bytes: formattedBytes })}
        </span>
      </div>

      {/* Mixed / lone CR EOL warning banner (mockups/item.html #cfg-eol-warning) */}
      {sourceEol.requiresConversionWarning ? (
        <div
          id={`json-eol-warning-${entryId}`}
          data-testid={`json-eol-warning-${entryId}`}
          data-json-eol-warning=""
          role="status"
          className="auth-status mb-2.5 text-[13px]"
        >
          <span>{tEntry('mixedEolWarning', { target: targetEolLabel })}</span>
        </div>
      ) : null}

      {/* Switch blocked or format refused error message */}
      {externalError ? (
        <div
          id={`json-switch-blocked-msg-${entryId}`}
          data-testid={`json-switch-blocked-msg-${entryId}`}
          role="alert"
          className="field-error mb-2.5 mt-0"
        >
          {externalError}
        </div>
      ) : null}
      {formatErrorMsg ? (
        <div
          id={`json-format-msg-${entryId}`}
          data-testid={`json-format-msg-${entryId}`}
          data-json-format-msg=""
          role="alert"
          className="field-error mb-2.5 mt-0"
        >
          {formatErrorMsg}
        </div>
      ) : null}

      <label htmlFor={`json-raw-textarea-${entryId}`} className="sr-only">
        {tJson('rawEditorLabel', { pos: positionNumber })}
      </label>
      <textarea
        ref={textareaRef}
        id={`json-raw-textarea-${entryId}`}
        data-testid={`json-raw-textarea-${entryId}`}
        data-json-raw-textarea=""
        rows={10}
        value={draftValue}
        aria-invalid={displayedIssue !== null || undefined}
        aria-describedby={
          displayedIssue !== null ? `${bytesCounterId} ${errorBoxId}` : bytesCounterId
        }
        className="field-input json-raw-editor resize-y text-[13px] leading-relaxed"
        {...VAULT_SECRET_INPUT_PROPS}
        onChange={(e) => {
          if (formatErrorMsg) setFormatErrorMsg(null);
          onDraftChange(e.target.value);
        }}
        onBlur={() => {
          flushValidationImmediate();
        }}
        onKeyDown={handleKeyDown}
      />

      {/* Parse error / over-cap box under the field (role="alert", P4FE1-10: no underline in textarea) */}
      {displayedIssue !== null ? (
        <div
          id={errorBoxId}
          data-testid={`json-raw-error-${entryId}`}
          data-json-raw-error=""
          role="alert"
          className="field-error mb-0 mt-2.5"
        >
          {displayedIssue.kind === 'invalid_unicode' ? (
            <p className="m-0">{tJson('rawInvalidUnicode')}</p>
          ) : displayedIssue.kind === 'over_cap' ? (
            <p className="m-0">{tJson('rawOverCap')}</p>
          ) : displayedIssue.parseError ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="m-0 font-semibold">
                {tJson('rawInvalidHeader', {
                  line: displayedIssue.parseError.line,
                  column: displayedIssue.parseError.column,
                  detail: translateParseErrorCode(displayedIssue.parseError.code),
                })}
              </p>
              <button
                type="button"
                data-testid={`json-raw-goto-btn-${entryId}`}
                data-json-raw-goto=""
                className="btn btn-tertiary btn-sm"
                onClick={handleGoToError}
              >
                {tJson('goToErrorBtn')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
