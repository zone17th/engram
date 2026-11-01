'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';

export const UNDO_TOAST_DEFAULT_DURATION_MS = 5_000;
export const UNDO_TOAST_KEYBOARD_DURATION_MS = 10_000;
export const UNDO_TOAST_MIN_AFTER_FOCUS_MS = 10_000;
export const UNDO_TOAST_MAX_VISIBLE = 3;

const APPLE_PLATFORM_PATTERN = /^(mac|iphone|ipad|ipod|ios)/i;

interface NavigatorWithUserAgentData {
  readonly userAgentData?: {
    readonly platform?: string;
  };
  readonly platform?: string;
}

/**
 * Detects whether the current platform uses Apple keyboard conventions (`⌘Z` / `metaKey`)
 * per plan §2.8 (P4FE5-1):
 * reads `navigator.userAgentData?.platform || navigator.platform` (joined with `||`, not `??`,
 * because `userAgentData.platform` may be an empty string) and matches `/^(mac|iphone|ipad|ipod|ios)/i`.
 */
export function isAppleUndoPlatform(nav?: NavigatorWithUserAgentData): boolean {
  const target: NavigatorWithUserAgentData | undefined =
    nav ?? (typeof navigator !== 'undefined' ? (navigator as NavigatorWithUserAgentData) : undefined);
  if (!target) return false;
  const platform = target.userAgentData?.platform || target.platform || '';
  return APPLE_PLATFORM_PATTERN.test(platform);
}

/**
 * Returns the platform-specific Undo shortcut string: `'⌘Z'` on Apple platforms, `'Ctrl+Z'` elsewhere.
 */
export function getUndoShortcutText(nav?: NavigatorWithUserAgentData): '⌘Z' | 'Ctrl+Z' {
  return isAppleUndoPlatform(nav) ? '⌘Z' : 'Ctrl+Z';
}

/**
 * Formats an action label with the platform Undo shortcut (e.g. `"Hoàn tác"` -> `"Hoàn tác (Ctrl+Z)"` or `"Hoàn tác (⌘Z)"`).
 * If the caller already included `(Ctrl+Z)` or `(⌘Z)`, normalizes it to the current platform's shortcut.
 */
export function formatUndoActionLabel(
  baseActionLabel: string,
  nav?: NavigatorWithUserAgentData,
): string {
  const shortcut = getUndoShortcutText(nav);
  const stripped = baseActionLabel.replace(/\s*\((?:Ctrl\+Z|⌘Z)\)\s*$/i, '').trim();
  return `${stripped} (${shortcut})`;
}

export interface UndoToastOptions {
  readonly id?: string;
  /** Primary toast message (must never contain decrypted entry body plaintext — only item/tag name). */
  readonly message: string;
  /** Optional secondary line (e.g. quick-add Undo scope note, P4FE2-13), also included in the live region. */
  readonly detail?: string;
  /**
   * Required localized action button text (caller passes from i18n, e.g. `t('undo')` — CCFE10).
   * If it does not already end with `(Ctrl+Z)` or `(⌘Z)`, the platform shortcut is appended
   * automatically; if it does, the shortcut is normalized to the active platform.
   */
  readonly actionLabel: string;
  /** Format function for the collapsed overflow button visible text (default `"+{count}"`). */
  readonly overflowLabel?: (hiddenCount: number) => string;
  /**
   * Accessible name (`aria-label`) or formatter for the collapsed `"+N"` overflow button (CCFE10).
   * Defaults to a descriptive label when omitted so assistive tech knows the button reveals hidden Undos.
   */
  readonly overflowAriaLabel?: string | ((hiddenCount: number) => string);
  /** Callback invoked when the user triggers Undo (button click or Ctrl/⌘+Z). */
  readonly onUndo: () => void | Promise<void>;
  /**
   * Optional callback invoked if `onUndo` throws or returns a rejected Promise (CCFE10).
   */
  readonly onError?: (error: unknown) => void;
  /**
   * Optional origin element or resolver to restore focus to when this toast disappears while holding focus,
   * or after keyboard Undo. Defaults to the active element at the moment `pushUndoToast` was called.
   */
  readonly returnFocusTo?: HTMLElement | null | (() => HTMLElement | null);
  /**
   * Explicit override for whether this toast was triggered by a keyboard action (10 s initial duration).
   * When omitted, detected automatically from the most recent user interaction (`keydown` vs `pointerdown`/`mousedown`/`touchstart`).
   */
  readonly triggeredByKeyboard?: boolean;
  /** Optional custom initial duration in milliseconds. */
  readonly durationMs?: number;
}

export interface UndoToastItem {
  readonly id: string;
  readonly message: string;
  readonly detail?: string;
  readonly actionLabel: string;
  readonly overflowLabel?: (hiddenCount: number) => string;
  readonly overflowAriaLabel?: string | ((hiddenCount: number) => string);
  readonly onUndo: () => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly returnFocusTo: HTMLElement | null | (() => HTMLElement | null);
}

export interface UndoToastContextValue {
  readonly toasts: readonly UndoToastItem[];
  readonly expanded: boolean;
  readonly paused: boolean;
  readonly pushUndoToast: (options: UndoToastOptions) => string;
  readonly triggerUndo: (id?: string) => void;
  readonly dismissUndoToast: (id: string) => void;
  readonly expandStack: () => void;
  /**
   * Marks an omnibox input element as having just been cleared by a quick-add save (P4FE2-3).
   * While focus stays in that empty input and the user has not typed or modified it,
   * pressing `Ctrl+Z` / `⌘Z` triggers the newest Undo toast instead of native input undo.
   * Any input event or non- empty value automatically invalidates this state.
   */
  readonly markOmniboxJustCleared: (inputElement: HTMLInputElement | HTMLTextAreaElement | null) => void;
  readonly clearOmniboxJustCleared: () => void;
}

const UndoToastContext = createContext<UndoToastContextValue | null>(null);

export function useUndoToast(): UndoToastContextValue {
  const ctx = useContext(UndoToastContext);
  if (!ctx) {
    throw new Error('useUndoToast must be used within an UndoToastProvider.');
  }
  return ctx;
}

export function useOptionalUndoToast(): UndoToastContextValue | null {
  return useContext(UndoToastContext);
}

function isEditableElement(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
  return false;
}

function resolveFocusTarget(
  target: HTMLElement | null | (() => HTMLElement | null),
): HTMLElement | null {
  const resolved = typeof target === 'function' ? target() : target;
  if (!resolved) return null;
  if (typeof document !== 'undefined' && !document.contains(resolved)) return null;
  return resolved;
}

interface ActiveTimerRecord {
  remainingMs: number;
  timerId: ReturnType<typeof setTimeout> | undefined;
  startedAtMs: number | null;
}

let nextToastAutoId = 1;

export function UndoToastProvider({
  children,
  onError,
  overflowAriaLabel,
}: {
  readonly children: ReactNode;
  /** Optional provider-level fallback error handler when a toast's `onUndo` rejects and has no per-toast `onError` (CCFE10). */
  readonly onError?: (error: unknown, item: UndoToastItem) => void;
  /** Optional provider-level accessible name formatter for the `+N` overflow button (CCFE10). */
  readonly overflowAriaLabel?: string | ((hiddenCount: number) => string);
}) {
  const [toasts, setToasts] = useState<UndoToastItem[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocusedInside, setIsFocusedInside] = useState(false);
  const [announcementSeq, setAnnouncementSeq] = useState(0);

  const stackRef = useRef<HTMLDivElement | null>(null);
  const isExpandingFocusMoveRef = useRef(false);
  const providerOnErrorRef = useRef(onError);
  providerOnErrorRef.current = onError;
  const timersRef = useRef<Map<string, ActiveTimerRecord>>(new Map());
  const toastsRef = useRef<UndoToastItem[]>([]);
  toastsRef.current = toasts;

  const lastInteractionWasKeyboardRef = useRef(false);
  const omniboxClearedElRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const isFocusedInsideRef = useRef(false);
  isFocusedInsideRef.current = isFocusedInside;

  const paused = isHovered || isFocusedInside || expanded;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Track whether the most recent user interaction was via keyboard or pointer/touch.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Modifier-only presses still count as keyboard interaction.
      if (e.key) {
        lastInteractionWasKeyboardRef.current = true;
      }
    };
    const onPointerOrMouse = () => {
      lastInteractionWasKeyboardRef.current = false;
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerOrMouse, true);
    window.addEventListener('mousedown', onPointerOrMouse, true);
    window.addEventListener('touchstart', onPointerOrMouse, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerOrMouse, true);
      window.removeEventListener('mousedown', onPointerOrMouse, true);
      window.removeEventListener('touchstart', onPointerOrMouse, true);
    };
  }, []);

  // Track changes to the registered omnibox element: as soon as the user types anything,
  // clear the "omnibox-just-cleared" exemption so native Ctrl+Z works inside the input.
  const markOmniboxJustCleared = useCallback(
    (inputElement: HTMLInputElement | HTMLTextAreaElement | null) => {
      omniboxClearedElRef.current = inputElement;
    },
    [],
  );

  const clearOmniboxJustCleared = useCallback(() => {
    omniboxClearedElRef.current = null;
  }, []);

  useEffect(() => {
    const onInput = (e: Event) => {
      if (omniboxClearedElRef.current && e.target === omniboxClearedElRef.current) {
        omniboxClearedElRef.current = null;
      }
    };
    window.addEventListener('input', onInput, true);
    return () => {
      window.removeEventListener('input', onInput, true);
    };
  }, []);

  const invokeUndoSafely = useCallback((item: UndoToastItem) => {
    try {
      const result = item.onUndo();
      if (result && typeof result.then === 'function') {
        void result.then(undefined, (err: unknown) => {
          if (item.onError) {
            item.onError(err);
          } else if (providerOnErrorRef.current) {
            providerOnErrorRef.current(err, item);
          }
        });
      }
    } catch (err) {
      if (item.onError) {
        item.onError(err);
      } else if (providerOnErrorRef.current) {
        providerOnErrorRef.current(err, item);
      }
    }
  }, []);

  const restoreFocusIfNeeded = useCallback(
    (toastItem: UndoToastItem, shouldRestoreFocus: boolean) => {
      if (!shouldRestoreFocus) return;
      const target = resolveFocusTarget(toastItem.returnFocusTo);
      if (target && typeof target.focus === 'function') {
        target.focus();
      }
    },
    [],
  );

  const removeToastInternal = useCallback(
    (id: string, reason: 'timeout' | 'undo' | 'dismiss', wasFocusInStack: boolean) => {
      const currentList = toastsRef.current;
      const targetToast = currentList.find((t) => t.id === id);
      const record = timersRef.current.get(id);
      clearTimeout(record?.timerId);
      timersRef.current.delete(id);

      const nextList = currentList.filter((t) => t.id !== id);
      toastsRef.current = nextList;
      setToasts(nextList);

      if (nextList.length <= UNDO_TOAST_MAX_VISIBLE) {
        setExpanded(false);
      }
      if (nextList.length === 0) {
        setIsHovered(false);
        setIsFocusedInside(false);
        isFocusedInsideRef.current = false;
      }

      if (targetToast && wasFocusInStack && (reason === 'undo' || reason === 'timeout')) {
        restoreFocusIfNeeded(targetToast, true);
      }
    },
    [restoreFocusIfNeeded],
  );

  const pauseAllTimers = useCallback((enforceMinFocusRemaining: boolean) => {
    const now = performance.now();
    for (const [, record] of timersRef.current.entries()) {
      if (record.timerId !== undefined) {
        clearTimeout(record.timerId);
        record.timerId = undefined;
      }
      if (record.startedAtMs !== null) {
        const elapsed = Math.max(0, now - record.startedAtMs);
        record.remainingMs = Math.max(0, record.remainingMs - elapsed);
        record.startedAtMs = null;
      }
      if (enforceMinFocusRemaining && record.remainingMs < UNDO_TOAST_MIN_AFTER_FOCUS_MS) {
        record.remainingMs = UNDO_TOAST_MIN_AFTER_FOCUS_MS;
      }
    }
  }, []);

  const startOrResumeAllTimers = useCallback(() => {
    if (pausedRef.current) return;
    const now = performance.now();
    for (const [id, record] of timersRef.current.entries()) {
      if (record.timerId !== undefined) continue;
      const delay = Math.max(0, record.remainingMs);
      record.startedAtMs = now;
      record.timerId = setTimeout(() => {
        const focusCurrentlyInStack =
          isFocusedInsideRef.current ||
          Boolean(
            stackRef.current &&
              typeof document !== 'undefined' &&
              document.activeElement &&
              stackRef.current.contains(document.activeElement),
          );
        removeToastInternal(id, 'timeout', focusCurrentlyInStack);
      }, delay);
    }
  }, [removeToastInternal]);

  // Synchronize timer pause/resume whenever hover, focus, or expanded state changes.
  useEffect(() => {
    if (paused) {
      pauseAllTimers(isFocusedInside);
    } else {
      startOrResumeAllTimers();
    }
  }, [paused, isFocusedInside, pauseAllTimers, startOrResumeAllTimers]);

  // Cleanup all timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const record of timers.values()) {
        clearTimeout(record.timerId);
      }
      timers.clear();
    };
  }, []);

  const pushUndoToast = useCallback(
    (options: UndoToastOptions): string => {
      const id = options.id ?? `undo-toast-${nextToastAutoId++}`;
      const isKeyboard = options.triggeredByKeyboard ?? lastInteractionWasKeyboardRef.current;
      const initialDurationMs =
        options.durationMs ??
        (isKeyboard ? UNDO_TOAST_KEYBOARD_DURATION_MS : UNDO_TOAST_DEFAULT_DURATION_MS);

      const defaultOrigin =
        typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      const item: UndoToastItem = {
        id,
        message: options.message,
        detail: options.detail,
        actionLabel: options.actionLabel,
        overflowLabel: options.overflowLabel,
        overflowAriaLabel: options.overflowAriaLabel,
        onUndo: options.onUndo,
        onError: options.onError,
        returnFocusTo: options.returnFocusTo !== undefined ? options.returnFocusTo : defaultOrigin,
      };
      const existingRecord = timersRef.current.get(id);
      clearTimeout(existingRecord?.timerId);

      const effectiveRemaining =
        isFocusedInsideRef.current && initialDurationMs < UNDO_TOAST_MIN_AFTER_FOCUS_MS
          ? UNDO_TOAST_MIN_AFTER_FOCUS_MS
          : initialDurationMs;

      const record: ActiveTimerRecord = {
        remainingMs: effectiveRemaining,
        timerId: undefined,
        startedAtMs: null,
      };
      timersRef.current.set(id, record);

      // Newest toast is placed first so top of stack / newest is index 0.
      const nextList = [item, ...toastsRef.current.filter((t) => t.id !== id)];
      toastsRef.current = nextList;
      setToasts(nextList);
      setAnnouncementSeq((prev) => prev + 1);
      if (!pausedRef.current) {
        const now = performance.now();
        record.startedAtMs = now;
        record.timerId = setTimeout(() => {
          const focusCurrentlyInStack =
            isFocusedInsideRef.current ||
            Boolean(
              stackRef.current &&
                typeof document !== 'undefined' &&
                document.activeElement &&
                stackRef.current.contains(document.activeElement),
            );
          removeToastInternal(id, 'timeout', focusCurrentlyInStack);
        }, effectiveRemaining);
      }

      return id;
    },
    [removeToastInternal],
  );

  const dismissUndoToast = useCallback(
    (id: string) => {
      const focusCurrentlyInStack =
        isFocusedInsideRef.current ||
        Boolean(
          stackRef.current &&
            typeof document !== 'undefined' &&
            document.activeElement &&
            stackRef.current.contains(document.activeElement),
        );
      removeToastInternal(id, 'dismiss', focusCurrentlyInStack);
    },
    [removeToastInternal],
  );

  const triggerUndo = useCallback(
    (id?: string) => {
      const currentList = toastsRef.current;
      if (currentList.length === 0) return;
      const target = id ? currentList.find((t) => t.id === id) : currentList[0];
      if (!target) return;

      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      const focusInStack =
        isFocusedInsideRef.current ||
        Boolean(stackRef.current && activeEl && stackRef.current.contains(activeEl));

      removeToastInternal(target.id, 'undo', focusInStack);
      invokeUndoSafely(target);
    },
    [removeToastInternal, invokeUndoSafely],
  );

  const expandStack = useCallback(() => {
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const wasFocusedInStack =
      isFocusedInsideRef.current ||
      Boolean(stackRef.current && activeEl && stackRef.current.contains(activeEl));

    pauseAllTimers(wasFocusedInStack);
    pausedRef.current = true;
    if (wasFocusedInStack) {
      isExpandingFocusMoveRef.current = true;
    }
    setExpanded(true);
  }, [pauseAllTimers]);

  // When the stack expands while focus was inside (e.g. keyboard Enter/Space on "+N"),
  // move focus to the first newly revealed Undo button (index UNDO_TOAST_MAX_VISIBLE)
  // so keyboard focus never drops to <body> or freezes timers (CCFE4).
  useEffect(() => {
    if (!expanded || !isExpandingFocusMoveRef.current) return;
    isExpandingFocusMoveRef.current = false;
    const stackEl = stackRef.current;
    if (!stackEl) return;
    const itemEls = stackEl.querySelectorAll<HTMLElement>('[data-testid="undo-toast-item"]');
    const firstRevealedCard = itemEls[UNDO_TOAST_MAX_VISIBLE] ?? itemEls[itemEls.length - 1];
    const targetButton = firstRevealedCard?.querySelector<HTMLButtonElement>('button') ?? null;
    if (targetButton) {
      targetButton.focus();
      isFocusedInsideRef.current = true;
      setIsFocusedInside(true);
    }
  }, [expanded]);

  // Global Ctrl+Z / ⌘Z listener per plan §2.8 (P4FE2-3, P4FE4-6, P4FE5-1).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (toastsRef.current.length === 0) return;
      if (e.defaultPrevented) return;
      if (e.key.toLowerCase() !== 'z') return;
      // Redo (Shift+Ctrl+Z / Shift+⌘Z) or Alt must never trigger Undo.
      if (e.shiftKey || e.altKey) return;

      const apple = isAppleUndoPlatform();
      const modifierMatch = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!modifierMatch) return;

      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      if (isEditableElement(activeEl)) {
        const clearedOmnibox = omniboxClearedElRef.current;
        const isJustClearedOmnibox =
          clearedOmnibox !== null &&
          activeEl === clearedOmnibox &&
          clearedOmnibox.value === '';
        if (!isJustClearedOmnibox) {
          return;
        }
      }

      e.preventDefault();
      const newest = toastsRef.current[0];
      if (!newest) return;
      const focusInStack =
        isFocusedInsideRef.current ||
        Boolean(stackRef.current && activeEl && stackRef.current.contains(activeEl));

      removeToastInternal(newest.id, 'undo', focusInStack);
      invokeUndoSafely(newest);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [removeToastInternal, invokeUndoSafely]);

  const handleMouseEnter = useCallback(() => {
    pauseAllTimers(false);
    pausedRef.current = true;
    setIsHovered(true);
  }, [pauseAllTimers]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    if (!isFocusedInsideRef.current) {
      setExpanded(false);
    }
  }, []);

  const handleFocusCapture = useCallback(() => {
    pauseAllTimers(true);
    isFocusedInsideRef.current = true;
    pausedRef.current = true;
    setIsFocusedInside(true);
  }, [pauseAllTimers]);

  const handleBlurCapture = useCallback(() => {
    // Check on next microtask/frame whether focus moved outside the stack container.
    queueMicrotask(() => {
      if (isExpandingFocusMoveRef.current) {
        return;
      }
      const stackEl = stackRef.current;
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      const stillInside = Boolean(stackEl && activeEl && stackEl.contains(activeEl));
      if (!stillInside) {
        isFocusedInsideRef.current = false;
        setIsFocusedInside(false);
        setExpanded((prevExpanded) => (isHovered ? prevExpanded : false));
      }
    });
  }, [isHovered]);

  const visibleToasts = expanded ? toasts : toasts.slice(0, UNDO_TOAST_MAX_VISIBLE);
  const hiddenCount = expanded ? 0 : Math.max(0, toasts.length - UNDO_TOAST_MAX_VISIBLE);
  const newestToast = toasts[0];

  const liveAnnouncement = useMemo(() => {
    if (!newestToast) return '';
    const actionWithShortcut = formatUndoActionLabel(newestToast.actionLabel);
    const parts = [newestToast.message];
    if (newestToast.detail) {
      parts.push(newestToast.detail);
    }
    parts.push(actionWithShortcut);
    // Append a toggled zero-width space on odd announcements so consecutive identical toasts
    // (e.g. "Đã lưu vào wifi" twice) trigger a DOM text mutation and are re-announced by screen readers (CCFE10).
    const zeroWidthSuffix = announcementSeq % 2 === 1 ? '\u200B' : '';
    return `${parts.join(' — ')}${zeroWidthSuffix}`;
  }, [newestToast, announcementSeq]);

  const contextValue = useMemo<UndoToastContextValue>(
    () => ({
      toasts,
      expanded,
      paused,
      pushUndoToast,
      triggerUndo,
      dismissUndoToast,
      expandStack,
      markOmniboxJustCleared,
      clearOmniboxJustCleared,
    }),
    [
      toasts,
      expanded,
      paused,
      pushUndoToast,
      triggerUndo,
      dismissUndoToast,
      expandStack,
      markOmniboxJustCleared,
      clearOmniboxJustCleared,
    ],
  );

  const overflowButtonText = useMemo(() => {
    if (hiddenCount <= 0) return '';
    const customFormatter = toasts.find((t) => t.overflowLabel)?.overflowLabel;
    return customFormatter ? customFormatter(hiddenCount) : `+${hiddenCount}`;
  }, [hiddenCount, toasts]);

  const overflowButtonAriaLabel = useMemo(() => {
    if (hiddenCount <= 0) return '';
    const itemSource = toasts.find((t) => t.overflowAriaLabel !== undefined)?.overflowAriaLabel;
    const source = itemSource ?? overflowAriaLabel;
    if (typeof source === 'function') {
      return source(hiddenCount);
    }
    if (typeof source === 'string' && source.trim().length > 0) {
      return source;
    }
    const sampleAction = newestToast ? newestToast.actionLabel : 'Undo';
    return `${overflowButtonText} (${sampleAction})`;
  }, [hiddenCount, toasts, overflowAriaLabel, newestToast, overflowButtonText]);
  return (
    <UndoToastContext.Provider value={contextValue}>
      {children}
      {/* Exactly ONE shared role="status" live region for the entire Undo toast stack (plan §2.8). */}
      <div
        ref={stackRef}
        data-testid="undo-toast-stack"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocusCapture={handleFocusCapture}
        onBlurCapture={handleBlurCapture}
        className={cn(
          'fixed bottom-7 left-1/2 z-[80] flex -translate-x-1/2 flex-col items-center gap-2',
          toasts.length === 0 && 'pointer-events-none',
        )}
      >
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {liveAnnouncement}
        </div>
        {visibleToasts.map((item) => (
          <UndoToastCard
            key={item.id}
            item={item}
            onAction={() => triggerUndo(item.id)}
          />
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            data-testid="undo-toast-overflow"
            aria-expanded={expanded}
            aria-label={overflowButtonAriaLabel}
            onClick={expandStack}
            className="toast !static !translate-x-0 cursor-pointer border-0 font-mono text-[13px] font-bold"
          >
            {overflowButtonText}
          </button>
        )}
      </div>
    </UndoToastContext.Provider>
  );
}

export function UndoToastCard({
  item,
  onAction,
  className,
}: {
  readonly item: Pick<UndoToastItem, 'id' | 'message' | 'detail' | 'actionLabel'>;
  readonly onAction: () => void;
  readonly className?: string;
}) {
  const formattedLabel = formatUndoActionLabel(item.actionLabel);
  return (
    <div
      data-testid="undo-toast-item"
      className={cn('toast !static !translate-x-0', className)}
    >
      <div className="flex flex-col gap-0.5">
        <span>{item.message}</span>
        {item.detail ? (
          <span className="text-[12px] text-[#A3A3A3]" data-testid="undo-toast-detail">
            {item.detail}
          </span>
        ) : null}
      </div>
      <button type="button" onClick={onAction}>
        {formattedLabel}
      </button>
    </div>
  );
}
