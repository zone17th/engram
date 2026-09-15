'use client';

import { useId } from 'react';
import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Lý do bị khoá — hiển thị và nối vào aria-describedby. */
  hint?: string;
  className?: string;
}

/**
 * Visual on/off do .switch[aria-checked='true'] trong tokens.css —
 * không dùng .switch-on / .switch-disabled (không tồn tại).
 */
export function Switch({ checked, onCheckedChange, label, disabled = false, hint, className }: SwitchProps) {
  const hintId = useId();
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-describedby={hint ? hintId : undefined}
        onClick={() => {
          if (!disabled) onCheckedChange(!checked);
        }}
        className={cn('switch', disabled && 'opacity-40 cursor-not-allowed')}
      >
        <span className="sr-only">{label}</span>
      </button>
      <span aria-hidden="true">{label}</span>
      {hint && (
        <span id={hintId} className="t-legal text-muted">
          {hint}
        </span>
      )}
    </span>
  );
}
