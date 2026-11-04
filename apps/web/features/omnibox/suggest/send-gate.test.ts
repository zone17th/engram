import { describe, expect, it } from 'vitest';
import {
  COMPOSITION_COMMIT_MAX_GRAPHEMES,
  SUGGEST_DEBOUNCE_MS,
  countGraphemes,
  createInitialSendGateState,
  createSendGate,
  evaluateEnterSearch,
  evaluateKeystrokeSend,
  evaluateSemanticReissue,
  extractTagModeToken,
  resolveOmniboxHelpTextKey,
  stepSendGateInput,
  syncSendGateOwnWrite,
  type KeystrokeSendDecision,
  type SemanticEligibilityContext,
} from './send-gate';

/**
 * Helper that simulates real native DOM listener wiring on a `<textarea>` element
 * (`beforeinput`, `input`, `compositionstart`, `compositionend`) per plan L13 / FE-3 / FE-19.
 */
function createTextareaWithGate(initialValue = '') {
  const textarea = document.createElement('textarea');
  textarea.value = initialValue;
  const gate = createSendGate(initialValue);

  textarea.addEventListener('beforeinput', (ev) => {
    const ie = ev as InputEvent;
    gate.handleBeforeInput({
      inputType: ie.inputType,
      data: ie.data,
      isComposing: ie.isComposing,
      currentDomValue: textarea.value,
    });
  });

  textarea.addEventListener('input', (ev) => {
    const ie = ev as InputEvent;
    gate.handleInput({
      inputType: 'inputType' in ie ? ie.inputType : undefined,
      data: 'data' in ie ? ie.data : undefined,
      isComposing: 'isComposing' in ie ? ie.isComposing : false,
      value: textarea.value,
    });
  });

  textarea.addEventListener('compositionstart', () => {
    gate.handleCompositionStart(textarea.value);
  });

  textarea.addEventListener('compositionend', (ev) => {
    const ce = ev as CompositionEvent;
    gate.handleCompositionEnd({
      value: textarea.value,
      data: ce.data,
    });
  });

  function dispatchNativeEdit(params: {
    readonly inputType: string;
    readonly data?: string | null;
    readonly nextValue: string;
    readonly isComposing?: boolean;
  }) {
    textarea.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: params.inputType,
        data: params.data ?? null,
        isComposing: params.isComposing ?? false,
      }),
    );
    textarea.value = params.nextValue;
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: params.inputType,
        data: params.data ?? null,
        isComposing: params.isComposing ?? false,
      }),
    );
  }

  function typeChar(ch: string) {
    const nextValue = textarea.value + ch;
    dispatchNativeEdit({
      inputType: 'insertText',
      data: ch,
      nextValue,
      isComposing: false,
    });
  }

  function typeStringCharByChar(
    text: string,
    context?: SemanticEligibilityContext,
  ): KeystrokeSendDecision[] {
    const decisions: KeystrokeSendDecision[] = [];
    for (const ch of text) {
      typeChar(ch);
      decisions.push(gate.decideKeystroke(context));
    }
    return decisions;
  }
  function setDraft(value: string) {
    textarea.value = value;
    gate.syncOwnWrite(value);
  }

  return {
    textarea,
    gate,
    dispatchNativeEdit,
    typeChar,
    typeStringCharByChar,
    setDraft,
  };
}

describe('features/omnibox/suggest/send-gate', () => {
  it('paste taints until empty', () => {
    const { gate, dispatchNativeEdit, typeChar } = createTextareaWithGate();

    dispatchNativeEdit({
      inputType: 'insertFromPaste',
      data: 'hunter2',
      nextValue: 'hunter2',
    });
    expect(gate.getState().tainted).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);
    expect(gate.decideKeystroke().gateClosed).toBe(true);

    // Deleting part of the pasted string keeps it tainted
    dispatchNativeEdit({
      inputType: 'deleteContentBackward',
      nextValue: 'hunter',
    });
    expect(gate.getState().tainted).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);

    // Typing another char while tainted stays tainted
    typeChar('s');
    expect(gate.getState().tainted).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);

    // Emptying the field clears taint
    dispatchNativeEdit({
      inputType: 'deleteWordBackward',
      nextValue: '',
    });
    expect(gate.getState().tainted).toBe(false);
    expect(gate.decideKeystroke().canSend).toBe(true);
    expect(gate.decideKeystroke().mode).toBe('recent');

    // Typing after empty works cleanly
    typeChar('w');
    expect(gate.getState().tainted).toBe(false);
    expect(gate.decideKeystroke().canSend).toBe(true);
    expect(gate.decideKeystroke().q).toBe('w');
  });

  it('insertFromDrop taints', () => {
    const { gate, dispatchNativeEdit } = createTextareaWithGate();
    dispatchNativeEdit({
      inputType: 'insertFromDrop',
      data: 'dropped-secret',
      nextValue: 'dropped-secret',
    });
    expect(gate.getState().tainted).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);
    expect(gate.decideKeystroke().blockReason).toBe('tainted');
  });

  it('insertReplacementText taints', () => {
    const { gate, dispatchNativeEdit, typeStringCharByChar } = createTextareaWithGate();
    typeStringCharByChar('wfi');
    expect(gate.getState().tainted).toBe(false);

    dispatchNativeEdit({
      inputType: 'insertReplacementText',
      data: 'wifi',
      nextValue: 'wifi',
    });
    expect(gate.getState().tainted).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);
  });

  it('historyUndo after typed text taints', () => {
    const { gate, dispatchNativeEdit, typeStringCharByChar } = createTextareaWithGate();
    typeStringCharByChar('wifi');
    expect(gate.getState().tainted).toBe(false);

    dispatchNativeEdit({
      inputType: 'historyUndo',
      nextValue: 'wif',
    });
    expect(gate.getState().tainted).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);
  });

  it('historyUndo of paste stays tainted', () => {
    const { gate, dispatchNativeEdit, typeStringCharByChar } = createTextareaWithGate();
    typeStringCharByChar('ab');
    dispatchNativeEdit({
      inputType: 'insertFromPaste',
      data: 'SECRET',
      nextValue: 'abSECRET',
    });
    expect(gate.getState().tainted).toBe(true);

    dispatchNativeEdit({
      inputType: 'historyUndo',
      nextValue: 'ab',
    });
    expect(gate.getState().tainted).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);
  });

  it('single insertText of 1 grapheme stays clean', () => {
    const { gate, typeChar } = createTextareaWithGate();
    typeChar('đ');
    expect(gate.getState().tainted).toBe(false);
    // Multi-codepoint single emoji grapheme cluster (family emoji / flag)
    const familyEmoji = '👨‍👩‍👧';
    expect(countGraphemes(familyEmoji)).toBe(1);
    typeChar(familyEmoji);
    expect(gate.getState().tainted).toBe(false);
    expect(gate.decideKeystroke().canSend).toBe(true);
  });

  it('single insertText of 2+ graphemes outside composition taints', () => {
    const { gate, dispatchNativeEdit } = createTextareaWithGate();
    dispatchNativeEdit({
      inputType: 'insertText',
      data: 'wifi',
      nextValue: 'wifi',
      isComposing: false,
    });
    expect(gate.getState().tainted).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);
    expect(gate.decideKeystroke().blockReason).toBe('tainted');
  });

  it('composition commit of many graphemes stays clean', () => {
    const { textarea, gate, dispatchNativeEdit } = createTextareaWithGate();

    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    expect(gate.getState().isComposing).toBe(true);

    dispatchNativeEdit({
      inputType: 'insertCompositionText',
      data: 'đường',
      nextValue: 'đường',
      isComposing: true,
    });
    expect(gate.getState().tainted).toBe(false);
    expect(gate.decideKeystroke().canSend).toBe(false);
    expect(gate.decideKeystroke().blockReason).toBe('composing');

    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'đường' }));
    expect(gate.getState().isComposing).toBe(false);
    expect(gate.getState().tainted).toBe(false);

    const decision = gate.decideKeystroke({
      semanticAvailable: true,
      semanticSuggest: true,
    });
    expect(decision.canSend).toBe(true);
    expect(decision.q).toBe('đường');
    expect(decision.qn).toBe('đường');
    expect(decision.allowSemantic).toBe(true);
    expect(decision.semanticFlags).toEqual([0, 1]);
  });

  it('composition commit > 64 graphemes taints', () => {
    const { textarea, gate, dispatchNativeEdit } = createTextareaWithGate();
    const longCommit = 'a'.repeat(COMPOSITION_COMMIT_MAX_GRAPHEMES + 1);

    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    dispatchNativeEdit({
      inputType: 'insertCompositionText',
      data: longCommit,
      nextValue: longCommit,
      isComposing: true,
    });
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: longCommit }));

    expect(gate.getState().tainted).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);
    expect(gate.decideKeystroke().blockReason).toBe('tainted');
  });

  it('syncOwnWrite then insertText stays clean', () => {
    const { gate, setDraft, typeChar } = createTextareaWithGate();

    // Omnibox Tab-fills a tag `#nhà ` via setDraft -> syncOwnWrite
    setDraft('#nhà ');
    expect(gate.getState().tainted).toBe(false);
    expect(gate.getState().prevValue).toBe('#nhà ');

    // User types next character
    typeChar('x');
    expect(gate.getState().tainted).toBe(false);
    const decision = gate.decideKeystroke();
    expect(decision.canSend).toBe(true);
    expect(decision.scope).toBe('tag');
    expect(decision.q).toBe('nhà');
  });

  it("syncOwnWrite('') clears taint", () => {
    const { gate, dispatchNativeEdit, setDraft, typeChar } = createTextareaWithGate();

    dispatchNativeEdit({
      inputType: 'insertFromPaste',
      data: 'pasted-secret',
      nextValue: 'pasted-secret',
    });
    expect(gate.getState().tainted).toBe(true);

    // Save clear / Esc clear via setDraft('') -> syncOwnWrite('')
    setDraft('');
    expect(gate.getState().tainted).toBe(false);
    expect(gate.getState().colonLocked).toBe(false);

    typeChar('w');
    expect(gate.getState().tainted).toBe(false);
    expect(gate.decideKeystroke().canSend).toBe(true);
    expect(gate.decideKeystroke().q).toBe('w');
  });

  it('foreign value change without syncOwnWrite taints', () => {
    const { textarea, gate, typeChar } = createTextareaWithGate();
    typeChar('a');
    expect(gate.getState().tainted).toBe(false);

    // Foreign code mutates textarea.value directly without calling syncOwnWrite
    textarea.value = 'injected-secret';
    // Next user keystroke arrives on top of the foreign value
    typeChar('!');
    expect(gate.getState().tainted).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);
    expect(gate.decideKeystroke().blockReason).toBe('tainted');
  });

  it('no send while composing', () => {
    const { textarea, gate, dispatchNativeEdit } = createTextareaWithGate();

    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    for (const step of ['d', 'dd', 'ddu', 'dduo', 'dduow', 'dduowng', 'dduowngf']) {
      dispatchNativeEdit({
        inputType: 'insertCompositionText',
        data: step,
        nextValue: step,
        isComposing: true,
      });
      const decision = gate.decideKeystroke();
      expect(decision.canSend).toBe(false);
      expect(decision.blockReason).toBe('composing');
      expect(decision.gateClosed).toBe(false);
    }
  });

  it('send after compositionend restarts debounce', () => {
    const { textarea, gate, dispatchNativeEdit } = createTextareaWithGate();
    expect(SUGGEST_DEBOUNCE_MS).toBe(120);

    const beforeSignal = gate.getState().restartDebounceSignal;
    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    dispatchNativeEdit({
      inputType: 'insertCompositionText',
      data: 'việt',
      nextValue: 'việt',
      isComposing: true,
    });
    expect(gate.decideKeystroke().canSend).toBe(false);

    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'việt' }));
    const afterDecision = gate.decideKeystroke({
      semanticAvailable: true,
      semanticSuggest: true,
    });
    expect(afterDecision.canSend).toBe(true);
    expect(afterDecision.q).toBe('việt');
    expect(afterDecision.restartDebounceSignal).toBe(beforeSignal + 1);
  });

  it('programmatic set taints', () => {
    const { textarea, gate } = createTextareaWithGate();
    textarea.value = 'programmatic-secret';
    // Dispatch plain `new Event('input')` without `inputType` (L13)
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(gate.getState().tainted).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);
    expect(gate.decideKeystroke().blockReason).toBe('tainted');
  });

  it('add mode never re-enables keystroke send', () => {
    const { gate, dispatchNativeEdit, typeStringCharByChar } = createTextareaWithGate();
    typeStringCharByChar('wifi: pass');
    expect(gate.getState().colonLocked).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);

    // Deleting the colon and body down to 'wifi' does NOT re-enable keystroke send
    dispatchNativeEdit({
      inputType: 'deleteContentBackward',
      nextValue: 'wifi',
    });
    expect(gate.getState().colonLocked).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);
    expect(gate.decideKeystroke().blockReason).toBe('colon_locked');

    // Only emptying the field re-enables send
    dispatchNativeEdit({
      inputType: 'deleteContentBackward',
      nextValue: '',
    });
    expect(gate.getState().colonLocked).toBe(false);
    expect(gate.decideKeystroke().canSend).toBe(true);
  });

  it('`#home:secretbody` sends nothing', () => {
    const ctx = { semanticAvailable: true, semanticSuggest: true } as const;
    const { gate, typeStringCharByChar, dispatchNativeEdit } = createTextareaWithGate();
    const trace = typeStringCharByChar('#home:secretbody', ctx);

    // Before `:`, `#home` is in `#` tag mode with semantic=0; from `:` onwards, every keystroke is blocked
    // and no keystroke decision EVER carries any character from `:secretbody`.
    const colonIdx = '#home:secretbody'.indexOf(':');
    for (let i = 0; i < trace.length; i += 1) {
      const d = trace[i]!;
      if (d.q !== undefined) {
        expect(d.q).not.toContain(':');
        expect(d.q).not.toContain('secret');
      }
      if (i >= colonIdx) {
        expect(d.canSend).toBe(false);
        expect(d.gateClosed).toBe(true);
        expect(d.blockReason).toBe('colon_locked');
        expect(d.q).toBeUndefined();
      }
    }

    const ks = gate.decideKeystroke(ctx);
    expect(ks.canSend).toBe(false);
    expect(ks.gateClosed).toBe(true);
    expect(ks.keepLocalTagCacheRows).toBe(true);
    expect(ks.blockReason).toBe('colon_locked');
    expect(ks.q).toBeUndefined();

    // Even if colon is deleted later, still locked until empty
    dispatchNativeEdit({
      inputType: 'deleteContentBackward',
      nextValue: '#home',
    });
    expect(gate.decideKeystroke(ctx).canSend).toBe(false);

    // Enter also refuses to send anything after colon in # mode
    const enter = gate.decideEnterSearch(ctx, '#home:secretbody');
    expect(enter.canSearch).toBe(false);
    expect(enter.q).toBe('');
  });

  it('`#home secret:x` sends nothing after colon', () => {
    const ctx = { semanticAvailable: true, semanticSuggest: true } as const;
    const { gate, typeStringCharByChar } = createTextareaWithGate();
    const trace = typeStringCharByChar('#home secret:x', ctx);

    const colonIdx = '#home secret:x'.indexOf(':');
    for (let i = 0; i < trace.length; i += 1) {
      const d = trace[i]!;
      if (d.q !== undefined) {
        expect(d.q).not.toContain('secret');
        expect(d.q).not.toContain(':');
      }
      if (i >= colonIdx) {
        expect(d.canSend).toBe(false);
        expect(d.gateClosed).toBe(true);
        expect(d.blockReason).toBe('colon_locked');
        expect(d.q).toBeUndefined();
      }
    }

    const ks = gate.decideKeystroke(ctx);
    expect(ks.canSend).toBe(false);
    expect(ks.gateClosed).toBe(true);
    expect(ks.blockReason).toBe('colon_locked');
    expect(ks.q).toBeUndefined();

    const enter = gate.decideEnterSearch(ctx);
    expect(enter.canSearch).toBe(false);
    expect(enter.q).toBe('');
  });

  it('`name: body` locks', () => {
    const ctx = { semanticAvailable: true, semanticSuggest: true } as const;
    const { gate, typeStringCharByChar } = createTextareaWithGate();
    const trace = typeStringCharByChar('name: body', ctx);

    const colonIdx = 'name: body'.indexOf(':');
    for (let i = 0; i < trace.length; i += 1) {
      const d = trace[i]!;
      if (d.q !== undefined) {
        expect(d.q).not.toContain(':');
        expect(d.q).not.toContain('body');
      }
      if (i >= colonIdx) {
        expect(d.canSend).toBe(false);
        expect(d.gateClosed).toBe(true);
        expect(d.blockReason).toBe('colon_locked');
        expect(d.q).toBeUndefined();
      }
    }

    const ks = gate.decideKeystroke(ctx);
    expect(ks.canSend).toBe(false);
    expect(ks.gateClosed).toBe(true);
    expect(ks.blockReason).toBe('colon_locked');
    expect(ks.q).toBeUndefined();

    const enter = gate.decideEnterSearch(ctx);
    expect(enter.canSearch).toBe(false);
    expect(enter.blockReason).toBe('colon_locked');
  });

  it('`wifi： mật khẩu` locks (full-width)', () => {
    const ctx = { semanticAvailable: true, semanticSuggest: true } as const;
    const { gate, typeStringCharByChar, dispatchNativeEdit } = createTextareaWithGate();
    const text = 'wifi： mật khẩu';
    const trace = typeStringCharByChar(text, ctx);

    const colonIdx = Array.from(text).indexOf('：');
    for (let i = 0; i < trace.length; i += 1) {
      const d = trace[i]!;
      if (d.q !== undefined) {
        expect(d.q).not.toContain('：');
        expect(d.q).not.toContain('mật');
        expect(d.q).not.toContain('khẩu');
      }
      if (i >= colonIdx) {
        expect(d.canSend).toBe(false);
        expect(d.gateClosed).toBe(true);
        expect(d.blockReason).toBe('colon_locked');
        expect(d.q).toBeUndefined();
      }
    }

    const ks = gate.decideKeystroke(ctx);
    expect(ks.canSend).toBe(false);
    expect(ks.gateClosed).toBe(true);
    expect(ks.blockReason).toBe('colon_locked');
    expect(ks.q).toBeUndefined();

    // Deleting full-width colon does not unlock until empty
    dispatchNativeEdit({
      inputType: 'deleteContentBackward',
      nextValue: 'wifi',
    });
    expect(gate.decideKeystroke(ctx).canSend).toBe(false);
  });

  it('`http://x` locks', () => {
    const ctx = { semanticAvailable: true, semanticSuggest: true } as const;
    const { gate, typeStringCharByChar, dispatchNativeEdit } = createTextareaWithGate();
    const trace = typeStringCharByChar('http://x', ctx);

    const colonIdx = 'http://x'.indexOf(':');
    for (let i = 0; i < trace.length; i += 1) {
      const d = trace[i]!;
      if (d.q !== undefined) {
        expect(d.q).not.toContain(':');
        expect(d.q).not.toContain('//x');
      }
      if (i >= colonIdx) {
        expect(d.canSend).toBe(false);
        expect(d.gateClosed).toBe(true);
        expect(d.blockReason).toBe('colon_locked');
        expect(d.q).toBeUndefined();
      }
    }

    const ks = gate.decideKeystroke(ctx);
    expect(ks.canSend).toBe(false);
    expect(ks.gateClosed).toBe(true);
    expect(ks.blockReason).toBe('colon_locked');
    expect(ks.q).toBeUndefined();

    // Deleting colon does not unlock keystroke send
    dispatchNativeEdit({
      inputType: 'deleteContentBackward',
      nextValue: 'httpx',
    });
    expect(gate.decideKeystroke(ctx).canSend).toBe(false);
  });

  it('tag mode sends token up to whitespace or colon only', () => {
    const { gate, typeStringCharByChar } = createTextareaWithGate();
    typeStringCharByChar('#home extra words');

    const ks = gate.decideKeystroke({ semanticAvailable: true, semanticSuggest: true });
    expect(ks.canSend).toBe(true);
    expect(ks.scope).toBe('tag');
    expect(ks.q).toBe('home');
    expect(ks.qn).toBe('home');
    expect(ks.allowSemantic).toBe(false);
    expect(ks.semanticFlags).toEqual([0]);

    // Direct token extractor also stops at colon as defense-in-depth
    expect(extractTagModeToken('#work:secret').token).toBe('work');
    expect(extractTagModeToken('#work：secret').token).toBe('work');
    expect(extractTagModeToken('#work secret').token).toBe('work');
  });

  it('multi-line never sends', () => {
    const { gate, dispatchNativeEdit, typeStringCharByChar } = createTextareaWithGate();
    typeStringCharByChar('line1');
    dispatchNativeEdit({
      inputType: 'insertLineBreak',
      data: '\n',
      nextValue: 'line1\nline2',
    });

    const ks = gate.decideKeystroke({ semanticAvailable: true, semanticSuggest: true });
    expect(ks.canSend).toBe(false);
    expect(ks.gateClosed).toBe(true);
    expect(ks.q).toBeUndefined();

    const enter = gate.decideEnterSearch({ semanticAvailable: true, semanticSuggest: true });
    expect(enter.canSearch).toBe(false);
    expect(enter.blockReason).toBe('multiline');
  });

  it("syncOwnWrite('name: body') then deleting ':' sends nothing; syncOwnWrite('http://x') and Tab fill 'name: ' lock", () => {
    // SPEC §3.5 rule 3: colon lock evaluated on syncOwnWrite as well
    const { gate, setDraft, dispatchNativeEdit } = createTextareaWithGate();

    setDraft('name: body');
    expect(gate.getState().colonLocked).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);

    dispatchNativeEdit({
      inputType: 'deleteContentBackward',
      nextValue: 'name',
    });
    expect(gate.getState().colonLocked).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);

    setDraft('');
    expect(gate.getState().colonLocked).toBe(false);

    setDraft('http://x');
    expect(gate.getState().colonLocked).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);

    setDraft('');
    // Tab fill on item sets `name: `
    setDraft('wifi: ');
    expect(gate.getState().colonLocked).toBe(true);
    expect(gate.decideKeystroke().canSend).toBe(false);
  });

  describe('negative tests for plan 2.24 items 1, 8, 9 (Enter on closed gate, reissue/retry/see-more on unclean draft, # mode always semantic=0)', () => {
    it('2.24 item 1: tainted/colon-locked/multi-line/> 200 rune -> allowSemantic=false and Enter on closed gate forces semantic=0', () => {
      const ctx = { semanticAvailable: true, semanticSuggest: true } as const;

      // 1. Pasted (tainted) draft -> Enter runs /search with semantic=0
      const pastedGate = createTextareaWithGate();
      pastedGate.dispatchNativeEdit({
        inputType: 'insertFromPaste',
        data: 'router phòng khách',
        nextValue: 'router phòng khách',
      });
      expect(pastedGate.gate.decideKeystroke(ctx).allowSemantic).toBe(false);
      const pastedEnter = pastedGate.gate.decideEnterSearch(ctx);
      expect(pastedEnter.canSearch).toBe(true);
      expect(pastedEnter.q).toBe('router phòng khách');
      expect(pastedEnter.semantic).toBe(0);
      expect(pastedEnter.requestMode).toBe('lex');

      // 2. `http://x` (colon-locked search mode) -> Enter runs /search with semantic=0
      const urlGate = createTextareaWithGate();
      urlGate.typeStringCharByChar('http://example.com');
      expect(urlGate.gate.decideKeystroke(ctx).allowSemantic).toBe(false);
      const urlEnter = urlGate.gate.decideEnterSearch(ctx);
      expect(urlEnter.canSearch).toBe(true);
      expect(urlEnter.q).toBe('http://example.com');
      expect(urlEnter.semantic).toBe(0);
      expect(urlEnter.requestMode).toBe('lex');

      // 3. Full-width colon `wifi： mật khẩu` -> colon-locked search mode -> Enter runs /search with semantic=0
      const fwGate = createTextareaWithGate();
      fwGate.typeStringCharByChar('wifi： mật khẩu');
      expect(fwGate.gate.decideKeystroke(ctx).allowSemantic).toBe(false);
      const fwEnter = fwGate.gate.decideEnterSearch(ctx);
      expect(fwEnter.canSearch).toBe(true);
      expect(fwEnter.semantic).toBe(0);
      expect(fwEnter.requestMode).toBe('lex');

      // 4. Multi-line draft -> allowSemantic=false and Enter does not call /search
      const multiState = syncSendGateOwnWrite(createInitialSendGateState(), 'line 1\nline 2');
      expect(evaluateKeystrokeSend(multiState, ctx).allowSemantic).toBe(false);
      const multiEnter = evaluateEnterSearch(multiState, ctx);
      expect(multiEnter.canSearch).toBe(false);
      expect(multiEnter.semantic).toBe(0);

      // 5. > 200 runes -> allowSemantic=false and Enter does not call /search
      const over200 = 'a'.repeat(201);
      let longState = createInitialSendGateState();
      longState = syncSendGateOwnWrite(longState, over200);
      expect(evaluateKeystrokeSend(longState, ctx).allowSemantic).toBe(false);
      expect(evaluateKeystrokeSend(longState, ctx).blockReason).toBe('too_long');
      const longEnter = evaluateEnterSearch(longState, ctx);
      expect(longEnter.canSearch).toBe(false);
      expect(longEnter.semantic).toBe(0);
    });

    it('2.24 item 8: toggle-on reissue, Retry-After retry, and see-more on an unclean draft never send semantic=1', () => {
      const ctx = { semanticAvailable: true, semanticSuggest: true } as const;

      // Pasted draft -> user clicks toggle ≈ ON -> canSendSemantic is false, semantic=0
      const { gate, dispatchNativeEdit } = createTextareaWithGate();
      dispatchNativeEdit({
        inputType: 'insertFromPaste',
        data: 'mạng không dây',
        nextValue: 'mạng không dây',
      });

      const reissueTainted = gate.decideSemanticReissue(ctx);
      expect(reissueTainted.canSendSemantic).toBe(false);
      expect(reissueTainted.semantic).toBe(0);
      expect(reissueTainted.q).toBeUndefined();

      // Colon-locked draft (`http://x`) -> toggle ≈ ON -> canSendSemantic is false, semantic=0
      const urlGate = createTextareaWithGate();
      urlGate.typeStringCharByChar('http://internal');
      const reissueColon = urlGate.gate.decideSemanticReissue(ctx);
      expect(reissueColon.canSendSemantic).toBe(false);
      expect(reissueColon.semantic).toBe(0);

      // Clean draft < 3 runes -> canSendSemantic is false, semantic=0
      const shortGate = createTextareaWithGate();
      shortGate.typeStringCharByChar('wi');
      expect(shortGate.gate.decideSemanticReissue(ctx).canSendSemantic).toBe(false);
      expect(shortGate.gate.decideSemanticReissue(ctx).semantic).toBe(0);

      // Clean draft >= 3 runes -> canSendSemantic is true, semantic=1
      shortGate.typeChar('f');
      shortGate.typeChar('i');
      const reissueClean = shortGate.gate.decideSemanticReissue(ctx);
      expect(reissueClean.canSendSemantic).toBe(true);
      expect(reissueClean.semantic).toBe(1);
      expect(reissueClean.q).toBe('wifi');

      // "See more" cursor pages ALWAYS send semantic=0 even on a clean draft
      expect(
        shortGate.gate.decideEnterSearch({ ...ctx, cursor: 'next_page_cursor' }).semantic,
      ).toBe(0);
      expect(
        shortGate.gate.decideSemanticReissue({ ...ctx, cursor: 'next_page_cursor' }).canSendSemantic,
      ).toBe(false);
      expect(
        evaluateSemanticReissue(shortGate.gate.getState(), { ...ctx, cursor: 'next_page_cursor' })
          .semantic,
      ).toBe(0);
    });

    it('2.24 item 9: `#zzz` Enter -> `semantic=0` and `#` mode always sends semantic=0 across keystroke, Enter, and toggle-on', () => {
      const ctx = { semanticAvailable: true, semanticSuggest: true } as const;
      const { gate, typeStringCharByChar } = createTextareaWithGate();
      typeStringCharByChar('#zzz');

      const ks = gate.decideKeystroke(ctx);
      expect(ks.canSend).toBe(true);
      expect(ks.scope).toBe('tag');
      expect(ks.q).toBe('zzz');
      expect(ks.allowSemantic).toBe(false);
      expect(ks.semanticFlags).toEqual([0]);
      expect(ks.requestMode).toBe('lex');

      // Even if caller passes scope='all', `#zzz` Enter-search forces scope='tag' and semantic=0 (FE-C23)
      const enter = gate.decideEnterSearch({ ...ctx, scope: 'all' });
      expect(enter.canSearch).toBe(true);
      expect(enter.scope).toBe('tag');
      expect(enter.q).toBe('zzz');
      expect(enter.qn).toBe('zzz');
      expect(enter.semantic).toBe(0);
      expect(enter.requestMode).toBe('lex');

      const reissue = gate.decideSemanticReissue(ctx);
      expect(reissue.canSendSemantic).toBe(false);
      expect(reissue.semantic).toBe(0);
    });
  });

  it('resolves help text key per SPEC §3.4 table and 2.24 item 4 (absent semantic_external defaults to true)', () => {
    const { gate, typeStringCharByChar, dispatchNativeEdit, setDraft } = createTextareaWithGate();

    // Open gate, search mode: absent semanticExternal -> external variant
    expect(gate.getHelpTextKey()).toBe('search.help.sentToServerExternal');
    expect(gate.getHelpTextKey({ semanticExternal: undefined })).toBe(
      'search.help.sentToServerExternal',
    );
    expect(gate.getHelpTextKey({ semanticExternal: true })).toBe(
      'search.help.sentToServerExternal',
    );
    expect(gate.getHelpTextKey({ semanticExternal: false })).toBe('search.help.sentToServer');

    // Open gate, `#` tag mode -> keeps P04 tagHint
    typeStringCharByChar('#home');
    expect(gate.getHelpTextKey({ semanticExternal: true })).toBe('content.omnibox.tagHint');

    // Colon in `#` mode -> enterToSearch
    typeStringCharByChar(':secret');
    expect(gate.getHelpTextKey({ semanticExternal: true })).toBe('search.help.enterToSearch');

    // Reset and paste -> enterToSearch
    setDraft('');
    dispatchNativeEdit({
      inputType: 'insertFromPaste',
      data: 'pasted',
      nextValue: 'pasted',
    });
    expect(gate.getHelpTextKey({ semanticExternal: false })).toBe('search.help.enterToSearch');

    // Add mode -> content.privacy
    setDraft('wifi: password');
    expect(resolveOmniboxHelpTextKey(gate.getState())).toBe('content.privacy');
  });

  it('reset() clears taint, colon lock, and prevValue on vault lock/logout', () => {
    const { gate, dispatchNativeEdit } = createTextareaWithGate();
    dispatchNativeEdit({
      inputType: 'insertFromPaste',
      data: 'wifi: secret',
      nextValue: 'wifi: secret',
    });
    expect(gate.getState().tainted).toBe(true);
    expect(gate.getState().colonLocked).toBe(true);

    gate.reset();
    expect(gate.getState()).toEqual({
      value: '',
      prevValue: '',
      tainted: false,
      colonLocked: false,
      isComposing: false,
      compositionStartValue: null,
      restartDebounceSignal: 0,
    });

    // Direct stepSendGateInput also works purely
    const stepped = stepSendGateInput(gate.getState(), {
      inputType: 'insertText',
      data: 'a',
      isComposing: false,
      prevValue: '',
      value: 'a',
    });
    expect(stepped.tainted).toBe(false);
    expect(stepped.value).toBe('a');
  });

  it('`!!!`, `#!!!`, and lone `#` produce isLocalEmptyMatch on Enter and do not close the gate on keystroke (RV-T9-FE1-6)', () => {
    const ctx = { semanticAvailable: true, semanticSuggest: true } as const;

    // 1. Search mode `!!!`: keystrokes do not send (`empty_normalized`), do NOT close the gate (`gateClosed: false`),
    // and Enter returns `canSearch: false, isLocalEmptyMatch: true`.
    const bangGate = createTextareaWithGate();
    const bangTrace = bangGate.typeStringCharByChar('!!!', ctx);
    for (const d of bangTrace) {
      expect(d.canSend).toBe(false);
      expect(d.gateClosed).toBe(false);
      expect(d.blockReason).toBe('empty_normalized');
      expect(d.q).toBeUndefined();
    }
    const bangEnter = bangGate.gate.decideEnterSearch(ctx);
    expect(bangEnter.canSearch).toBe(false);
    expect(bangEnter.isLocalEmptyMatch).toBe(true);
    expect(bangEnter.blockReason).toBe('empty_normalized');
    expect(bangEnter.semantic).toBe(0);

    // 2. `#!!!` in tag mode: `#` sends `q: '#'`, then `!` tokens do not send and do NOT close the gate;
    // Enter returns `canSearch: false, isLocalEmptyMatch: true`.
    const tagBangGate = createTextareaWithGate();
    const tagBangTrace = tagBangGate.typeStringCharByChar('#!!!', ctx);
    expect(tagBangTrace[0]?.canSend).toBe(true);
    expect(tagBangTrace[0]?.q).toBe('#');
    for (const d of tagBangTrace.slice(1)) {
      expect(d.canSend).toBe(false);
      expect(d.gateClosed).toBe(false);
      expect(d.keepLocalTagCacheRows).toBe(true);
      expect(d.blockReason).toBe('empty_normalized');
    }
    const tagBangEnter = tagBangGate.gate.decideEnterSearch(ctx);
    expect(tagBangEnter.canSearch).toBe(false);
    expect(tagBangEnter.isLocalEmptyMatch).toBe(true);
    expect(tagBangEnter.blockReason).toBe('empty_normalized');
    expect(tagBangEnter.scope).toBe('tag');

    // 3. Lone `#`: keystroke sends `q: '#'` (scope='tag', semantic=0), Enter returns `isLocalEmptyMatch: true`.
    const loneHashGate = createTextareaWithGate();
    loneHashGate.typeChar('#');
    const loneHashKs = loneHashGate.gate.decideKeystroke(ctx);
    expect(loneHashKs.canSend).toBe(true);
    expect(loneHashKs.q).toBe('#');
    expect(loneHashKs.scope).toBe('tag');
    expect(loneHashKs.allowSemantic).toBe(false);
    const loneHashEnter = loneHashGate.gate.decideEnterSearch(ctx);
    expect(loneHashEnter.canSearch).toBe(false);
    expect(loneHashEnter.isLocalEmptyMatch).toBe(true);
    expect(loneHashEnter.blockReason).toBe('empty_normalized');
  });

  it('fails closed (taints without throwing) when Intl.Segmenter is unavailable (RV-T9-FE1-8)', () => {
    const originalSegmenter = Intl.Segmenter;
    try {
      Object.defineProperty(Intl, 'Segmenter', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      const { gate, typeChar } = createTextareaWithGate();
      expect(() => typeChar('w')).not.toThrow();
      expect(gate.getState().tainted).toBe(true);
      expect(gate.decideKeystroke().canSend).toBe(false);
      expect(gate.decideKeystroke().blockReason).toBe('tainted');

      // Enter still works in lexical mode (`semantic=0`) as P04 fallback
      const enter = gate.decideEnterSearch({ semanticAvailable: true, semanticSuggest: true });
      expect(enter.canSearch).toBe(true);
      expect(enter.semantic).toBe(0);
    } finally {
      Object.defineProperty(Intl, 'Segmenter', {
        value: originalSegmenter,
        configurable: true,
        writable: true,
      });
    }
  });

  it('missed compositionend followed by multi-grapheme insertText taints and composition commit with colon locks (RV-T9-FE1-10, RV-T9-FE1-11)', () => {
    // 1. Missed `compositionend` followed by 5-grapheme `insertText` (isComposing: false) -> MUST taint
    const { textarea, gate, dispatchNativeEdit } = createTextareaWithGate();
    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    expect(gate.getState().isComposing).toBe(true);

    // No `compositionend` fired (e.g. mobile blur quirk); next event is a non-composing `insertText` of 5 graphemes
    dispatchNativeEdit({
      inputType: 'insertText',
      data: 'hello',
      nextValue: 'hello',
      isComposing: false,
    });
    expect(gate.getState().tainted).toBe(true);
    expect(gate.getState().isComposing).toBe(false);
    expect(gate.decideKeystroke().canSend).toBe(false);
    expect(gate.decideKeystroke().blockReason).toBe('tainted');

    // 2. Composition commit containing `:` locks the gate until empty
    const compColon = createTextareaWithGate();
    compColon.textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    compColon.dispatchNativeEdit({
      inputType: 'insertCompositionText',
      data: 'wifi:123',
      nextValue: 'wifi:123',
      isComposing: true,
    });
    compColon.textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'wifi:123' }));
    expect(compColon.gate.getState().colonLocked).toBe(true);
    expect(compColon.gate.decideKeystroke().canSend).toBe(false);
    expect(compColon.gate.decideKeystroke().blockReason).toBe('colon_locked');
  });
});
