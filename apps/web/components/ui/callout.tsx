import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type CalloutTone = 'error' | 'warning' | 'success' | 'info';

/**
 * Border colour per tone. `.card-error` / `.card-warning` come from styles/tokens.css (mockup);
 * the mockup has no success class, so success uses the Tailwind `border-success` utility
 * (var(--success)). `info` keeps the plain card border, as the mockup's neutral status cards do.
 */
const TONE_CLASS: Record<CalloutTone, string | undefined> = {
  error: 'card-error',
  warning: 'card-warning',
  success: 'border-success',
  info: undefined,
};

export interface CalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: CalloutTone;
  /** Mono eyebrow (`t-label`, muted), e.g. an error code. */
  label?: ReactNode;
  /** One-line heading (14px semibold, body colour). */
  title?: ReactNode;
  /** Body text (13px, muted). Pass block content when it needs its own markup. */
  children?: ReactNode;
}

/**
 * Status card from the mockups (unlock/onboarding/recovery/item error cards):
 * `card` + tone border + optional `t-label` eyebrow + title + body. Presentation only:
 * no role is set by default, so the caller keeps whatever live-region semantics
 * (`role="alert"` / `role="status"`) and test ids it already has, passed as props.
 */
export function Callout({ tone = 'info', label, title, children, className, ...props }: CalloutProps) {
  return (
    <div className={cn('card p-5', TONE_CLASS[tone], className)} {...props}>
      {label != null && <p className="t-label mb-2 text-muted">{label}</p>}
      {title != null && <p className="m-0 mb-1 text-[14px] font-semibold text-body">{title}</p>}
      {children != null && <div className="text-[13px] text-muted">{children}</div>}
    </div>
  );
}
