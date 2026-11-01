import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryProvider } from '@/components/query-provider';
import {
  UndoToastProvider,
  useUndoToast,
  type UndoToastContextValue,
  type UndoToastOptions,
} from '@/components/ui/undo-toast';
import { AppHeader } from '@/components/app-shell/app-header';
import { ThemeProvider } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTrigger } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Toast } from '@/components/ui/toast';
import * as vaultProviderMod from '@/features/vault/vault-provider';
import type { VaultContextValue } from '@/features/vault/vault-provider';
import viMessages from '@/messages/vi.json';
import { NextIntlClientProvider } from 'next-intl';

/**
 * Undo buttons only. The collapsed "+N" overflow button's accessible name is `+N · Hoàn tác`
 * (CCFE2-4), so a bare /Hoàn tác/ role query also matches it; exclude it by test id.
 */
function getUndoButtons(): HTMLElement[] {
  return screen
    .getAllByRole('button', { name: /Hoàn tác/i })
    .filter((el) => el.getAttribute('data-testid') !== 'undo-toast-overflow');
}

function TestHarness({
  onPushReady,
}: {
  readonly onPushReady?: (api: UndoToastContextValue) => void;
}) {
  const api = useUndoToast();
  const originButtonRef = useRef<HTMLButtonElement>(null);
  const omniboxInputRef = useRef<HTMLInputElement>(null);
  const regularInputRef = useRef<HTMLInputElement>(null);

  onPushReady?.(api);

  return (
    <div>
      <button type="button" ref={originButtonRef} data-testid="origin-btn">
        Origin Button
      </button>
      <input
        type="text"
        ref={omniboxInputRef}
        data-testid="omnibox-input"
        aria-label="Omnibox"
      />
      <input
        type="text"
        ref={regularInputRef}
        data-testid="regular-input"
        aria-label="Regular Input"
      />
      <button type="button" data-testid="outside-btn">
        Outside Button
      </button>
    </div>
  );
}

function stubNavigatorPlatform(config: {
  userAgentDataPlatform?: string;
  platform?: string;
}) {
  const nav: Record<string, unknown> = {
    platform: config.platform ?? '',
  };
  if (config.userAgentDataPlatform !== undefined) {
    nav.userAgentData = { platform: config.userAgentDataPlatform };
  }
  vi.stubGlobal('navigator', nav);
}

describe('components/ui/undo-toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubNavigatorPlatform({ userAgentDataPlatform: 'Windows', platform: 'Win32' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps two consecutive Undos both clickable with independent timers', () => {
    let api!: UndoToastContextValue;
    render(
      <UndoToastProvider>
        <TestHarness
          onPushReady={(ctx) => {
            api = ctx;
          }}
        />
      </UndoToastProvider>,
    );

    const undo1 = vi.fn();
    const undo2 = vi.fn();

    act(() => {
      api.pushUndoToast({ id: 't1', message: 'Đã xoá entry 1', actionLabel: 'Hoàn tác', onUndo: undo1 });
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    act(() => {
      api.pushUndoToast({ id: 't2', message: 'Đã xoá entry 2', actionLabel: 'Hoàn tác', onUndo: undo2 });
    });
    const items = screen.getAllByTestId('undo-toast-item');
    expect(items).toHaveLength(2);
    expect(screen.getByText('Đã xoá entry 1')).toBeInTheDocument();
    expect(screen.getByText('Đã xoá entry 2')).toBeInTheDocument();

    const buttons = getUndoButtons();
    expect(buttons).toHaveLength(2);

    // Click both Undos consecutively
    act(() => {
      fireEvent.click(buttons[0]!);
    });
    expect(undo2).toHaveBeenCalledTimes(1);
    expect(undo1).toHaveBeenCalledTimes(0);

    const remainingButtons = getUndoButtons();
    expect(remainingButtons).toHaveLength(1);
    act(() => {
      fireEvent.click(remainingButtons[0]!);
    });
    expect(undo1).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByTestId('undo-toast-item')).toHaveLength(0);
  });

  it('uses 5 s default duration and 10 s after a keyboard action, pauses on hover/focus, and guarantees ≥10 s left after focus', async () => {
    let api!: UndoToastContextValue;
    render(
      <UndoToastProvider>
        <TestHarness
          onPushReady={(ctx) => {
            api = ctx;
          }}
        />
      </UndoToastProvider>,
    );

    // 1. Pointer-triggered toast defaults to 5 s
    act(() => {
      fireEvent.pointerDown(screen.getByTestId('origin-btn'));
      api.pushUndoToast({ id: 'pointer-toast', message: 'Đã xoá bằng chuột', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
    });
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(screen.getByText('Đã xoá bằng chuột')).toBeInTheDocument();

    // Focus inside the toast when only 1 s was remaining -> paused AND bumped to ≥10 s remaining
    const undoBtn = screen.getByRole('button', { name: /Hoàn tác/i });
    act(() => {
      undoBtn.focus();
      fireEvent.focusIn(undoBtn);
    });

    // While focused, even 30 s does not expire the toast
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Đã xoá bằng chuột')).toBeInTheDocument();

    // Blur to outside button -> timer resumes with at least 10 s remaining
    const outsideBtn = screen.getByTestId('outside-btn');
    await act(async () => {
      outsideBtn.focus();
      fireEvent.focusOut(undoBtn, { relatedTarget: outsideBtn });
      await Promise.resolve();
    });

    act(() => {
      vi.advanceTimersByTime(9_900);
    });
    expect(screen.getByText('Đã xoá bằng chuột')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Đã xoá bằng chuột')).not.toBeInTheDocument();

    // 2. Keyboard-triggered toast gets 10 s initial duration
    act(() => {
      fireEvent.keyDown(window, { key: 'Enter' });
      api.pushUndoToast({ id: 'kbd-toast', message: 'Đã lưu bằng Enter', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
    });
    act(() => {
      vi.advanceTimersByTime(9_500);
    });
    expect(screen.getByText('Đã lưu bằng Enter')).toBeInTheDocument();

    // 3. Hovering the stack pauses timers until mouseLeave (CCFE9)
    const stackEl = screen.getByTestId('undo-toast-stack');
    act(() => {
      fireEvent.mouseEnter(stackEl);
    });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText('Đã lưu bằng Enter')).toBeInTheDocument();

    act(() => {
      fireEvent.mouseLeave(stackEl);
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByText('Đã lưu bằng Enter')).not.toBeInTheDocument();
  });

  it('does not trigger Undo on Ctrl+Z inside an ordinary input, but DOES trigger Undo in a just-cleared omnibox until the user types', () => {
    let api!: UndoToastContextValue;
    render(
      <UndoToastProvider>
        <TestHarness
          onPushReady={(ctx) => {
            api = ctx;
          }}
        />
      </UndoToastProvider>,
    );

    const undoSpy = vi.fn();
    const regularInput = screen.getByTestId('regular-input') as HTMLInputElement;
    const omniboxInput = screen.getByTestId('omnibox-input') as HTMLInputElement;

    act(() => {
      api.pushUndoToast({ id: 't-input', message: 'Đã lưu vào wifi', actionLabel: 'Hoàn tác', onUndo: undoSpy });
    });

    // Focus inside regular input -> Ctrl+Z does NOT trigger toast Undo
    regularInput.focus();
    act(() => {
      fireEvent.keyDown(regularInput, { key: 'z', ctrlKey: true });
    });
    expect(undoSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Đã lưu vào wifi')).toBeInTheDocument();

    // Omnibox just cleared after quick-add -> Ctrl+Z DOES trigger Undo while empty and untouched
    omniboxInput.value = '';
    omniboxInput.focus();
    act(() => {
      api.markOmniboxJustCleared(omniboxInput);
    });
    act(() => {
      fireEvent.keyDown(omniboxInput, { key: 'z', ctrlKey: true });
    });
    expect(undoSpy).toHaveBeenCalledTimes(1);

    // Push another toast, mark omnibox cleared, then user types 1 character -> Ctrl+Z no longer triggers toast Undo
    const undoSpy2 = vi.fn();
    act(() => {
      api.pushUndoToast({ id: 't-input-2', message: 'Đã lưu vào docker', actionLabel: 'Hoàn tác', onUndo: undoSpy2 });
      api.markOmniboxJustCleared(omniboxInput);
    });
    act(() => {
      omniboxInput.value = 'a';
      fireEvent.input(omniboxInput, { target: { value: 'a' } });
    });
    act(() => {
      fireEvent.keyDown(omniboxInput, { key: 'z', ctrlKey: true });
    });
    expect(undoSpy2).not.toHaveBeenCalled();
    expect(screen.getByText('Đã lưu vào docker')).toBeInTheDocument();
  });

  it(
    'CCFE10 & CCFE2-4: "+N" overflow button builds accessible name from caller actionLabel without English fallback or stale aria-expanded, and supports custom overflowAriaLabel',
    () => {
      let api!: UndoToastContextValue;
      const { unmount } = render(
        <UndoToastProvider>
          <TestHarness
            onPushReady={(ctx) => {
              api = ctx;
            }}
          />
        </UndoToastProvider>,
      );

      act(() => {
        api.pushUndoToast({ id: 'a1', message: 'Toast 1', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
        api.pushUndoToast({ id: 'a2', message: 'Toast 2', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
        api.pushUndoToast({ id: 'a3', message: 'Toast 3', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
        api.pushUndoToast({ id: 'a4', message: 'Toast 4', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
      });

      const defaultOverflowBtn = screen.getByTestId('undo-toast-overflow');
      expect(defaultOverflowBtn).toHaveTextContent('+1');
      expect(defaultOverflowBtn).toHaveAttribute('aria-label', '+1 · Hoàn tác');
      expect(defaultOverflowBtn).not.toHaveAttribute('aria-expanded');
      unmount();

      render(
        <UndoToastProvider overflowAriaLabel={(n) => `Hiện thêm ${n} thao tác hoàn tác`}>
          <TestHarness
            onPushReady={(ctx) => {
              api = ctx;
            }}
          />
        </UndoToastProvider>,
      );

      act(() => {
        api.pushUndoToast({ id: 'b1', message: 'Toast B1', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
        api.pushUndoToast({ id: 'b2', message: 'Toast B2', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
        api.pushUndoToast({ id: 'b3', message: 'Toast B3', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
        api.pushUndoToast({ id: 'b4', message: 'Toast B4', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
      });

      const customOverflowBtn = screen.getByTestId('undo-toast-overflow');
      expect(customOverflowBtn).toHaveAttribute('aria-label', 'Hiện thêm 1 thao tác hoàn tác');
      expect(customOverflowBtn).not.toHaveAttribute('aria-expanded');
    },
    15_000,
  );

  it(
    'CCFE9: collapsed 4th toast expires on its own independent clock when stack is not paused',
    () => {
      let api!: UndoToastContextValue;
      render(
        <UndoToastProvider>
          <TestHarness
            onPushReady={(ctx) => {
              api = ctx;
            }}
          />
        </UndoToastProvider>,
      );

      act(() => {
        api.pushUndoToast({
          id: 'clock-1',
          message: 'Oldest short clock',
          actionLabel: 'Hoàn tác',
          durationMs: 3_000,
          onUndo: vi.fn(),
        });
        api.pushUndoToast({
          id: 'clock-2',
          message: 'Toast clock 2',
          actionLabel: 'Hoàn tác',
          durationMs: 8_000,
          onUndo: vi.fn(),
        });
        api.pushUndoToast({
          id: 'clock-3',
          message: 'Toast clock 3',
          actionLabel: 'Hoàn tác',
          durationMs: 8_000,
          onUndo: vi.fn(),
        });
        api.pushUndoToast({
          id: 'clock-4',
          message: 'Toast clock 4',
          actionLabel: 'Hoàn tác',
          durationMs: 8_000,
          onUndo: vi.fn(),
        });
      });

      expect(screen.getByTestId('undo-toast-overflow')).toHaveTextContent('+1');

      // Advance 3.1 s without hover/focus -> the collapsed 4th toast (clock-1) expires on its own timer
      act(() => {
        vi.advanceTimersByTime(3_100);
      });
      expect(screen.queryByTestId('undo-toast-overflow')).not.toBeInTheDocument();
      expect(screen.getAllByTestId('undo-toast-item')).toHaveLength(3);

      // Clear remaining
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.queryAllByTestId('undo-toast-item')).toHaveLength(0);
    },
    15_000,
  );

  // Root cause of the earlier hangs (advisor-dec-134 / fix-3): every user-event API call runs inside RTL's
  // `asyncWrapper`, which awaits `setTimeout(resolve, 0)` and only advances it when a `jest` global with fake
  // timers exists. Under `vi.useFakeTimers()` that timer is faked and never fires, so `user.tab()/keyboard()`
  // never settle (user-event's `advanceTimers`/`delay: null` options do not cover this). So the real-keyboard
  // test below runs on REAL timers and the timer assertions use fake timers WITHOUT user-event.
  it(
    'CCFE4 (a): real keyboard Tab -> "+N" then Enter expands the stack and moves focus to the 4th Undo (real timers, user-event)',
    async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      let api!: UndoToastContextValue;
      const { unmount } = render(
        <UndoToastProvider>
          <TestHarness
            onPushReady={(ctx) => {
              api = ctx;
            }}
          />
        </UndoToastProvider>,
      );

      try {
        const outsideBtn = screen.getByTestId('outside-btn');
        outsideBtn.focus();

        // 60 s durations: nothing can expire while the test runs.
        act(() => {
          for (const [id, message] of [
            ['k1', 'Toast 1 (oldest)'],
            ['k2', 'Toast 2'],
            ['k3', 'Toast 3'],
            ['k4', 'Toast 4 (newest)'],
          ] as const) {
            api.pushUndoToast({
              id,
              message,
              actionLabel: 'Hoàn tác',
              durationMs: 60_000,
              onUndo: vi.fn(),
            });
          }
        });
        expect(getUndoButtons()).toHaveLength(3);

        // outsideBtn -> Undo(4) -> Undo(3) -> Undo(2) -> "+1"
        const overflowBtn = screen.getByTestId('undo-toast-overflow');
        for (let i = 0; i < 4 && document.activeElement !== overflowBtn; i += 1) {
          await user.tab();
        }
        expect(document.activeElement).toBe(overflowBtn);

        await user.keyboard('{Enter}');

        const allUndoBtns = getUndoButtons();
        expect(allUndoBtns).toHaveLength(4);
        expect(screen.getByText('Toast 1 (oldest)')).toBeInTheDocument();
        expect(screen.queryByTestId('undo-toast-overflow')).not.toBeInTheDocument();
        expect(document.activeElement).toBe(allUndoBtns[3]);
      } finally {
        unmount();
      }
    },
    15_000,
  );

  it(
    'CCFE4 (b): focus on "+N" pauses every timer; after expansion timers stay paused while focus is inside, then resume and expire once focus leaves (fake timers, no user-event)',
    async () => {
      let api!: UndoToastContextValue;
      render(
        <UndoToastProvider>
          <TestHarness
            onPushReady={(ctx) => {
              api = ctx;
            }}
          />
        </UndoToastProvider>,
      );

      const outsideBtn = screen.getByTestId('outside-btn');
      outsideBtn.focus();

      act(() => {
        for (const [id, message] of [
          ['u1', 'Toast 1 (oldest)'],
          ['u2', 'Toast 2'],
          ['u3', 'Toast 3'],
          ['u4', 'Toast 4 (newest)'],
        ] as const) {
          api.pushUndoToast({ id, message, actionLabel: 'Hoàn tác', onUndo: vi.fn() });
        }
      });

      const overflowBtn = screen.getByTestId('undo-toast-overflow');
      expect(overflowBtn).toHaveAttribute('aria-label', '+1 · Hoàn tác');

      // Focusing "+1" pauses all timers, including the collapsed 4th toast's.
      act(() => {
        overflowBtn.focus();
      });
      expect(document.activeElement).toBe(overflowBtn);
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(screen.getAllByTestId('undo-toast-item')).toHaveLength(3);
      expect(screen.getByTestId('undo-toast-overflow')).toBeInTheDocument();

      // Browser fires click for Enter/Space on a button: expand and move focus to the 4th Undo.
      act(() => {
        fireEvent.click(overflowBtn);
      });
      const allUndoBtns = getUndoButtons();
      expect(allUndoBtns).toHaveLength(4);
      expect(screen.getByText('Toast 1 (oldest)')).toBeInTheDocument();
      expect(document.activeElement).toBe(allUndoBtns[3]);

      // While focus stays inside the expanded stack, timers stay paused.
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(screen.getAllByTestId('undo-toast-item')).toHaveLength(4);

      // Focus leaves the stack: the deferred blur check runs on a microtask, then timers resume.
      await act(async () => {
        outsideBtn.focus();
        await Promise.resolve();
      });
      expect(document.activeElement).toBe(outsideBtn);

      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(screen.queryAllByTestId('undo-toast-item')).toHaveLength(0);
      expect(document.activeElement).toBe(outsideBtn);
    },
    15_000,
  );

  it('returns focus to origin when Undo is activated with focus inside toast, and does NOT move focus when focus already left the toast before timeout', async () => {
    let api!: UndoToastContextValue;
    render(
      <UndoToastProvider>
        <TestHarness
          onPushReady={(ctx) => {
            api = ctx;
          }}
        />
      </UndoToastProvider>,
    );

    const originBtn = screen.getByTestId('origin-btn');
    const outsideBtn = screen.getByTestId('outside-btn');

    // Case 1: Focus is at originBtn when toast is created; user moves focus into toast and clicks Undo -> focus returns to originBtn
    originBtn.focus();
    expect(document.activeElement).toBe(originBtn);

    const undo1 = vi.fn();
    act(() => {
      api.pushUndoToast({ id: 'focus-return', message: 'Đã xoá mục', actionLabel: 'Hoàn tác', onUndo: undo1 });
    });

    const toastUndoBtn = screen.getByRole('button', { name: /Hoàn tác/i });
    act(() => {
      toastUndoBtn.focus();
      fireEvent.focusIn(toastUndoBtn);
    });
    expect(document.activeElement).toBe(toastUndoBtn);

    act(() => {
      fireEvent.click(toastUndoBtn);
    });
    expect(undo1).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(originBtn);

    // Case 2 (CCFE9 & CCFE10): Ctrl+Z when focus is inside the toast stack returns focus to origin;
    // Ctrl+Z when focus is outside the toast stack does NOT steal focus back to origin
    originBtn.focus();
    const undoCtrlZInStack = vi.fn();
    act(() => {
      api.pushUndoToast({
        id: 'ctrlz-in-stack',
        message: 'Đã xoá mục 2',
        actionLabel: 'Hoàn tác',
        onUndo: undoCtrlZInStack,
      });
    });
    const toastUndoBtnInStack = screen.getByRole('button', { name: /Hoàn tác/i });
    act(() => {
      toastUndoBtnInStack.focus();
      fireEvent.focusIn(toastUndoBtnInStack);
    });
    expect(document.activeElement).toBe(toastUndoBtnInStack);
    act(() => {
      fireEvent.keyDown(toastUndoBtnInStack, { key: 'z', ctrlKey: true });
    });
    expect(undoCtrlZInStack).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(originBtn);

    // Now focus is moved to outsideBtn (not in toast stack) before pressing Ctrl+Z -> focus stays on outsideBtn
    originBtn.focus();
    const undoCtrlZOutside = vi.fn();
    act(() => {
      api.pushUndoToast({
        id: 'ctrlz-outside',
        message: 'Đã xoá mục 3',
        actionLabel: 'Hoàn tác',
        onUndo: undoCtrlZOutside,
      });
    });
    outsideBtn.focus();
    expect(document.activeElement).toBe(outsideBtn);
    act(() => {
      fireEvent.keyDown(outsideBtn, { key: 'z', ctrlKey: true });
    });
    expect(undoCtrlZOutside).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(outsideBtn);

    // Case 3: Focus enters toast, then leaves toast to outsideBtn, then toast times out -> focus stays on outsideBtn (not moved back to originBtn)
    originBtn.focus();
    act(() => {
      api.pushUndoToast({ id: 'focus-left', message: 'Đã xoá tag', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
    });

    const toastUndoBtn2 = screen.getByRole('button', { name: /Hoàn tác/i });
    act(() => {
      toastUndoBtn2.focus();
      fireEvent.focusIn(toastUndoBtn2);
    });

    await act(async () => {
      outsideBtn.focus();
      fireEvent.focusOut(toastUndoBtn2, { relatedTarget: outsideBtn });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(outsideBtn);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.queryByText('Đã xoá tag')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(outsideBtn);
  });

  it('detects Apple vs non-Apple platforms via userAgentData.platform || navigator.platform, renders ⌘Z vs Ctrl+Z, and rejects Ctrl+Shift+Z', () => {
    // 1. navigator.userAgentData = { platform: 'macOS' } -> ⌘Z + metaKey only
    stubNavigatorPlatform({ userAgentDataPlatform: 'macOS', platform: 'Win32' });
    let api!: UndoToastContextValue;
    const { unmount } = render(
      <UndoToastProvider>
        <TestHarness
          onPushReady={(ctx) => {
            api = ctx;
          }}
        />
      </UndoToastProvider>,
    );

    const macUndo = vi.fn();
    act(() => {
      api.pushUndoToast({ id: 'mac-1', message: 'Đã lưu macOS', actionLabel: 'Hoàn tác', onUndo: macUndo });
    });
    expect(screen.getByRole('button', { name: 'Hoàn tác (⌘Z)' })).toBeInTheDocument();
    // ctrlKey on macOS must NOT trigger Undo
    act(() => {
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    });
    expect(macUndo).not.toHaveBeenCalled();

    // metaKey + shiftKey (Redo) must NOT trigger Undo
    act(() => {
      fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    });
    expect(macUndo).not.toHaveBeenCalled();

    // metaKey alone triggers Undo
    act(() => {
      fireEvent.keyDown(window, { key: 'z', metaKey: true });
    });
    expect(macUndo).toHaveBeenCalledTimes(1);
    unmount();

    // 2. Only navigator.platform = 'MacIntel' (or empty userAgentData.platform with || fallback) -> ⌘Z + metaKey
    stubNavigatorPlatform({ userAgentDataPlatform: '', platform: 'MacIntel' });
    const { unmount: unmount2 } = render(
      <UndoToastProvider>
        <TestHarness
          onPushReady={(ctx) => {
            api = ctx;
          }}
        />
      </UndoToastProvider>,
    );

    const macIntelUndo = vi.fn();
    act(() => {
      api.pushUndoToast({ id: 'mac-2', message: 'Đã lưu MacIntel', actionLabel: 'Hoàn tác', onUndo: macIntelUndo });
    });
    expect(screen.getByRole('button', { name: 'Hoàn tác (⌘Z)' })).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(window, { key: 'z', metaKey: true });
    });
    expect(macIntelUndo).toHaveBeenCalledTimes(1);
    unmount2();

    // 3. { platform: 'Windows' } -> Ctrl+Z + ctrlKey, and Ctrl+Shift+Z does NOT Undo
    stubNavigatorPlatform({ userAgentDataPlatform: 'Windows', platform: 'Win32' });
    render(
      <UndoToastProvider>
        <TestHarness
          onPushReady={(ctx) => {
            api = ctx;
          }}
        />
      </UndoToastProvider>,
    );

    const winUndo = vi.fn();
    act(() => {
      api.pushUndoToast({ id: 'win-1', message: 'Đã lưu Windows', actionLabel: 'Hoàn tác', onUndo: winUndo });
    });
    expect(screen.getByRole('button', { name: 'Hoàn tác (Ctrl+Z)' })).toBeInTheDocument();

    // metaKey on Windows must NOT trigger Undo
    act(() => {
      fireEvent.keyDown(window, { key: 'z', metaKey: true });
    });
    expect(winUndo).not.toHaveBeenCalled();

    // Ctrl+Shift+Z must NOT trigger Undo
    act(() => {
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    });
    expect(winUndo).not.toHaveBeenCalled();

    // Ctrl+Z triggers Undo
    act(() => {
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    });
    expect(winUndo).toHaveBeenCalledTimes(1);
  });

  it('maintains exactly one role="status" live region for the entire stack regardless of how many toasts are queued', () => {
    let api!: UndoToastContextValue;
    render(
      <UndoToastProvider>
        <TestHarness
          onPushReady={(ctx) => {
            api = ctx;
          }}
        />
      </UndoToastProvider>,
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);

    const pushToast = (opts: UndoToastOptions) => {
      act(() => {
        api.pushUndoToast(opts);
      });
    };

    pushToast({ id: 's1', message: 'Đã lưu mục 1', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
    pushToast({
      id: 's2',
      message: 'Đã lưu vào wifi',
      detail: 'Hoàn tác chỉ xoá nội dung vừa lưu; mục và tag vẫn giữ',
      actionLabel: 'Hoàn tác',
      onUndo: vi.fn(),
    });
    const firstWifiAnnouncement = screen.getByRole('status').textContent;

    // Consecutive identical toast text produces a distinct DOM textContent so screen readers re-announce it (CCFE10)
    pushToast({
      id: 's3',
      message: 'Đã lưu vào wifi',
      detail: 'Hoàn tác chỉ xoá nội dung vừa lưu; mục và tag vẫn giữ',
      actionLabel: 'Hoàn tác',
      onUndo: vi.fn(),
    });
    const secondWifiAnnouncement = screen.getByRole('status').textContent;
    expect(secondWifiAnnouncement).not.toBe(firstWifiAnnouncement);

    pushToast({ id: 's4', message: 'Đã lưu mục 4', actionLabel: 'Hoàn tác', onUndo: vi.fn() });

    const statusRegions = screen.getAllByRole('status');
    expect(statusRegions).toHaveLength(1);
    expect(statusRegions[0]).toHaveTextContent('Đã lưu mục 4');
    expect(statusRegions[0]).toHaveTextContent('Hoàn tác (Ctrl+Z)');
  });

  it('CCFE10: catches rejected onUndo promises and surfaces the error through onError callback without unhandled rejection', async () => {
    let api!: UndoToastContextValue;
    const providerErrorSpy = vi.fn();
    render(
      <UndoToastProvider onError={providerErrorSpy}>
        <TestHarness
          onPushReady={(ctx) => {
            api = ctx;
          }}
        />
      </UndoToastProvider>,
    );

    const itemErrorSpy = vi.fn();
    const boom = new Error('restore failed');

    act(() => {
      api.pushUndoToast({
        id: 'err-toast-1',
        message: 'Đã xoá mục',
        actionLabel: 'Undo',
        onUndo: async () => {
          throw boom;
        },
        onError: itemErrorSpy,
      });
    });

    const undoBtn = screen.getByRole('button', { name: 'Undo (Ctrl+Z)' });
    await act(async () => {
      fireEvent.click(undoBtn);
      await Promise.resolve();
    });

    expect(itemErrorSpy).toHaveBeenCalledTimes(1);
    expect(itemErrorSpy).toHaveBeenCalledWith(boom);
    expect(providerErrorSpy).not.toHaveBeenCalled();

    // Provider-level fallback when item.onError is omitted
    const boom2 = new Error('restore failed 2');
    act(() => {
      api.pushUndoToast({
        id: 'err-toast-2',
        message: 'Đã xoá mục 2',
        actionLabel: 'Undo',
        onUndo: () => Promise.reject(boom2),
      });
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      await Promise.resolve();
    });

    expect(providerErrorSpy).toHaveBeenCalledTimes(1);
    expect(providerErrorSpy.mock.calls[0]?.[0]).toBe(boom2);
  });

  it('CCFE5: UndoToastProvider mounts inside QueryProvider and exposes useUndoToast to app children', () => {
    let api!: UndoToastContextValue;
    render(
      <QueryProvider>
        <UndoToastProvider>
          <TestHarness
            onPushReady={(ctx) => {
              api = ctx;
            }}
          />
        </UndoToastProvider>
      </QueryProvider>,
    );

    act(() => {
      api.pushUndoToast({
        id: 'layout-toast',
        message: 'Đã lưu trong app layout',
        actionLabel: 'Hoàn tác',
        onUndo: vi.fn(),
      });
    });

    expect(screen.getByText('Đã lưu trong app layout')).toBeInTheDocument();
  });
});

describe('FU3 UI-TOUCH-44: coarse-pointer 44x44 touch targets on header actions and primary ui controls', () => {
  it('defines :where(.touch-target) with zero-specificity position: relative under @media (pointer: coarse) in globals.css, excludes static/!static hosts, and does not alter tokens.css (LEAD-FU3-1, RV-B-FE-7)', () => {
    const globalsCss = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8');
    expect(globalsCss).toMatch(/@media\s*\(pointer:\s*coarse\)/);
    expect(globalsCss).toMatch(
      /:where\(\.touch-target:not\(\.static\):not\(\.\\!static\)\)\s*\{\s*position:\s*relative;\s*\}/,
    );
    expect(globalsCss).not.toMatch(/(?<!:where\()\.touch-target[^{]*\{\s*position:\s*relative;\s*\}/);
    expect(globalsCss).toMatch(
      /\.touch-target:not\(\.switch\):not\(\.chip-x\):not\(\.static\):not\(\.\\!static\)::after,\s*\.switch\.touch-target:not\(\.static\):not\(\.\\!static\)::before/,
    );
    expect(globalsCss).toMatch(/inset:\s*min\(0px,\s*calc\(\(100%\s*-\s*44px\)\s*\/\s*2\)\)/);
  });

  it('RV-B-FE-7: undo-toast overflow button has no .touch-target class, carries coarse 44x44 min-size utilities, and no component combines .touch-target with static/!static', () => {
    expect(DialogTrigger.displayName).toBeTruthy();
    expect(DialogClose.displayName).toBeTruthy();

    let api!: UndoToastContextValue;
    render(
      <UndoToastProvider>
        <TestHarness
          onPushReady={(ctx) => {
            api = ctx;
          }}
        />
      </UndoToastProvider>,
    );

    act(() => {
      api.pushUndoToast({ id: 'rv7-1', message: 'Toast 1', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
      api.pushUndoToast({ id: 'rv7-2', message: 'Toast 2', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
      api.pushUndoToast({ id: 'rv7-3', message: 'Toast 3', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
      api.pushUndoToast({ id: 'rv7-4', message: 'Toast 4', actionLabel: 'Hoàn tác', onUndo: vi.fn() });
    });

    const overflowBtn = screen.getByTestId('undo-toast-overflow');
    expect(overflowBtn).not.toHaveClass('touch-target');
    expect(overflowBtn).toHaveClass('toast', '!static');
    expect(overflowBtn.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
    expect(overflowBtn.className).toContain('[@media(pointer:coarse)]:min-w-[44px]');

    // Guard over component and feature sources: no class string combines `touch-target` with `static` or `!static`
    const webRoot = resolve(__dirname, '../..');
    const scanDirs = ['components', 'features', 'app'];
    const collectTsxFiles = (dir: string): string[] => {
      const entries = readdirSync(dir);
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          files.push(...collectTsxFiles(full));
        } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
          files.push(full);
        }
      }
      return files;
    };

    const offenders: string[] = [];
    for (const sub of scanDirs) {
      for (const file of collectTsxFiles(join(webRoot, sub))) {
        const source = readFileSync(file, 'utf8');
        const lines = source.split(/\r?\n/);
        lines.forEach((line, idx) => {
          if (/\btouch-target\b/.test(line) && /(?:^|\s|['"`])!?static(?:\s|['"`]|$)/.test(line)) {
            offenders.push(`${file}:${idx + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('applies .touch-target to primary ui controls (Button, Chip, Segmented, Switch, Field password toggle, DialogTrigger/DialogClose, Toast)', () => {
    const noop = vi.fn();
    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <div>
          <Button size="sm">Primary sm</Button>
          <Chip count={3}>#nhà</Chip>
          <Segmented
            value="a"
            onChange={noop}
            options={[
              { value: 'a', label: 'Tab A' },
              { value: 'b', label: 'Tab B' },
            ]}
          />
          <Switch checked={false} onCheckedChange={noop} label="Bật gợi ý" />
          <Field label="Mật khẩu" type="password" />
          <Toast message="Đã sao chép" action={{ label: 'Đóng', onAction: noop }} />
          <Dialog defaultOpen={false}>
            <DialogTrigger>Mở hộp thoại</DialogTrigger>
            <DialogContent aria-describedby={undefined}>
              <DialogHeader title="Hộp thoại" />
              <DialogClose>Huỷ hộp thoại</DialogClose>
            </DialogContent>
          </Dialog>
        </div>
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole('button', { name: 'Primary sm' })).toHaveClass('btn', 'btn-sm', 'touch-target');
    expect(screen.getByRole('button', { name: /#nhà/ })).toHaveClass('chip', 'touch-target');
    expect(screen.getByRole('radio', { name: 'Tab A' })).toHaveClass('touch-target');
    expect(screen.getByRole('radio', { name: 'Tab B' })).toHaveClass('touch-target');
    expect(screen.getByRole('switch', { name: 'Bật gợi ý' })).toHaveClass('switch', 'touch-target');
    expect(screen.getByRole('button', { name: 'Hiện' })).toHaveClass(
      'field-toggle',
      'touch-target',
    );
    expect(screen.getByRole('button', { name: 'Đóng' })).toHaveClass('touch-target');
    const dialogTrigger = screen.getByRole('button', { name: 'Mở hộp thoại' });
    expect(dialogTrigger).toHaveClass('touch-target');

    fireEvent.click(dialogTrigger);
    expect(screen.getByRole('button', { name: 'Huỷ hộp thoại' })).toHaveClass('touch-target');
  });

  it('applies .touch-target and coarse-pointer 44px sizing to AppHeader actions (locked and open vault states)', () => {
    const useOptionalVaultSpy = vi.spyOn(vaultProviderMod, 'useOptionalVault').mockReturnValue(null);

    const { rerender } = render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <ThemeProvider>
          <AppHeader vault={{ state: 'locked' }} showLogout={false} />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    const logoLink = screen.getByRole('link', { name: 'engram — Mục gần đây' });
    const settingsLink = screen.getByRole('link', { name: 'Cài đặt' });
    const themeButton = screen.getByRole('button', { name: 'Đổi giao diện sáng/tối' });
    const mobileLockedStandIn = screen.getByLabelText('Vault đang khoá');

    expect(logoLink).toHaveClass('touch-target');
    expect(settingsLink).toHaveClass('btn', 'btn-tertiary', 'touch-target');
    expect(themeButton).toHaveClass('btn', 'btn-tertiary', 'btn-icon');
    expect(mobileLockedStandIn.className).toContain('[@media(pointer:coarse)]:h-[44px]');
    expect(mobileLockedStandIn.className).toContain('[@media(pointer:coarse)]:w-[44px]');

    // Simulate unlocked vault context so lock buttons render
    useOptionalVaultSpy.mockReturnValue({
      state: 'unlocked',
      minutesLeft: 15,
      lockNow: vi.fn(),
    } as unknown as VaultContextValue);

    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <ThemeProvider>
          <AppHeader vault={{ state: 'open', minutesLeft: 15 }} showLogout={false} />
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    const desktopLockBtn = screen.getByTestId('vault-lock-button');
    const mobileLockBtn = screen.getByTestId('vault-lock-button-mobile');

    expect(desktopLockBtn).toHaveClass('touch-target');
    expect(desktopLockBtn.className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
    expect(desktopLockBtn.className).toContain('[@media(pointer:coarse)]:min-w-[44px]');
    expect(desktopLockBtn.querySelector('.vault-pill')?.className).toContain(
      '[@media(pointer:coarse)]:min-h-[44px]',
    );
    expect(mobileLockBtn).toHaveClass('touch-target');
    expect(mobileLockBtn.className).toContain('[@media(pointer:coarse)]:h-[44px]');
    expect(mobileLockBtn.className).toContain('[@media(pointer:coarse)]:w-[44px]');

    useOptionalVaultSpy.mockRestore();
  });
});
