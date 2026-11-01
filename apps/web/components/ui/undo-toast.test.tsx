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

    const buttons = screen.getAllByRole('button', { name: /Hoàn tác/i });
    expect(buttons).toHaveLength(2);

    // Click both Undos consecutively
    act(() => {
      fireEvent.click(buttons[0]!);
    });
    expect(undo2).toHaveBeenCalledTimes(1);
    expect(undo1).toHaveBeenCalledTimes(0);

    const remainingButtons = screen.getAllByRole('button', { name: /Hoàn tác/i });
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

  it('CCFE4 & CCFE9 & CCFE10: "+N" button has aria-expanded and accessible name, keyboard activation (Tab/Enter) moves focus to the 4th Undo without collapsing or freezing timers, and collapsed 4th toast expires on its own clock', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let api!: UndoToastContextValue;
    render(
      <UndoToastProvider overflowAriaLabel={(n) => `Hiện thêm ${n} thao tác hoàn tác`}>
        <TestHarness
          onPushReady={(ctx) => {
            api = ctx;
          }}
        />
      </UndoToastProvider>,
    );

    // Subcase A (CCFE9): Collapsed 4th toast expires on its own independent clock when stack is not paused
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
    expect(screen.getByTestId('undo-toast-overflow')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('undo-toast-overflow')).toHaveAttribute(
      'aria-label',
      'Hiện thêm 1 thao tác hoàn tác',
    );

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

    // Subcase B (CCFE4): Keyboard user Tabs to "+1" and presses Enter -> focus moves to the 4th (newly shown) Undo button, stack stays expanded, and after tabbing out timers resume and expire
    const undo1 = vi.fn();
    const undo2 = vi.fn();
    const undo3 = vi.fn();
    const undo4 = vi.fn();

    const outsideBtn = screen.getByTestId('outside-btn');
    outsideBtn.focus();

    act(() => {
      api.pushUndoToast({ id: 'u1', message: 'Toast 1 (oldest)', actionLabel: 'Hoàn tác', onUndo: undo1 });
      api.pushUndoToast({ id: 'u2', message: 'Toast 2', actionLabel: 'Hoàn tác', onUndo: undo2 });
      api.pushUndoToast({ id: 'u3', message: 'Toast 3', actionLabel: 'Hoàn tác', onUndo: undo3 });
      api.pushUndoToast({ id: 'u4', message: 'Toast 4 (newest)', actionLabel: 'Hoàn tác', onUndo: undo4 });
    });

    // Tab through outsideBtn -> Toast 4 Undo -> Toast 3 Undo -> Toast 2 Undo -> "+1" overflow button
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();

    const overflowBtn = screen.getByTestId('undo-toast-overflow');
    expect(document.activeElement).toBe(overflowBtn);
    expect(overflowBtn).toHaveAttribute('aria-expanded', 'false');

    // Focusing "+1" pauses all timers including the collapsed 4th toast
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getAllByTestId('undo-toast-item')).toHaveLength(3);

    // Activate "+1" with Enter via userEvent keyboard
    await user.keyboard('{Enter}');

    // Stack expands, does NOT collapse on microtask, and focus moves to the newly revealed 4th Undo button
    const allUndoBtns = screen.getAllByRole('button', { name: /Hoàn tác/i });
    expect(allUndoBtns).toHaveLength(4);
    expect(screen.getByText('Toast 1 (oldest)')).toBeInTheDocument();
    expect(document.activeElement).toBe(allUndoBtns[3]);

    // While focus remains on the 4th Undo button, timers stay paused
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getAllByTestId('undo-toast-item')).toHaveLength(4);

    // Move focus outside the stack -> stack collapses and timers resume (not frozen forever), expiring all toasts after ≥10 s
    await act(async () => {
      outsideBtn.focus();
      fireEvent.focusOut(allUndoBtns[3]!, { relatedTarget: outsideBtn });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(outsideBtn);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.queryAllByTestId('undo-toast-item')).toHaveLength(0);
  });

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
