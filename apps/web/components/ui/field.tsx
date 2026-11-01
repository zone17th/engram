'use client';

import {
  forwardRef,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';

export type FieldInputType = 'text' | 'email' | 'password';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  hint?: string;
  error?: string;
  type?: FieldInputType;
  /** Bật nút hiện/ẩn cho type=password. */
  passwordToggle?: boolean;
  /** Nhãn cho nút toggle — mặc định theo trạng thái visible. */
  passwordToggleLabels?: { show: string; hide: string };
  wrapperClassName?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  {
    id: idProp,
    label,
    hint,
    error,
    type = 'text',
    passwordToggle = type === 'password',
    passwordToggleLabels,
    className,
    wrapperClassName,
    disabled,
    ...inputProps
  },
  ref,
) {
  const t = useTranslations('auth.fields');
  const resolvedToggleLabels = passwordToggleLabels ?? {
    show: t('showPassword'),
    hide: t('hidePassword'),
  };
  const autoId = useId();
  const inputId = idProp ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = (error ? errorId : hintId) ?? undefined;

  const [visible, setVisible] = useState(false);
  const isPassword = type === 'password';
  const inputType = isPassword && passwordToggle && visible ? 'text' : type;

  const input = (
    <input
      ref={ref}
      id={inputId}
      type={inputType}
      disabled={disabled}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      className={cn('field-input', className)}
      {...inputProps}
    />
  );

  return (
    <div className={cn('field', isPassword && passwordToggle && 'field-password', wrapperClassName)}>
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      {isPassword && passwordToggle ? (
        <div className="relative">
          {input}
          <button
            type="button"
            className="field-toggle touch-target"
            disabled={disabled}
            aria-label={visible ? resolvedToggleLabels.hide : resolvedToggleLabels.show}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? resolvedToggleLabels.hide : resolvedToggleLabels.show}
          </button>
        </div>
      ) : (
        input
      )}
      {hint && !error && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
});

/** Focus field đầu tiên có lỗi sau submit — dùng ref map hoặc query trong form. */
export function focusFirstInvalidField(root: HTMLElement | Document = document) {
  const invalid = root.querySelector<HTMLElement>('.field-input[aria-invalid="true"]');
  invalid?.focus();
}

export type AuthStatusTone = 'loading' | 'sent' | 'error';

export function AuthStatus({
  tone,
  children,
  className,
}: {
  tone: AuthStatusTone;
  children: ReactNode;
  className?: string;
}) {
  if (tone === 'error') {
    return (
      <div role="alert" className={cn('auth-alert', className)}>
        {children}
      </div>
    );
  }
  return (
    <div role="status" className={cn('auth-status', className)}>
      {children}
    </div>
  );
}
