'use client';

import * as SwitchPrimitive from '@radix-ui/react-switch';
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
 * Radix Switch + class `.switch` từ tokens.css (data-state=checked).
 */
export function Switch({ checked, onCheckedChange, label, disabled = false, hint, className }: SwitchProps) {
  const hintId = useId();
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <SwitchPrimitive.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        className={cn('switch touch-target', disabled && 'opacity-40 cursor-not-allowed')}
      />
      <span aria-hidden="true">{label}</span>
      {hint && (
        <span id={hintId} className="t-legal text-muted">
          {hint}
        </span>
      )}
    </span>
  );
}
