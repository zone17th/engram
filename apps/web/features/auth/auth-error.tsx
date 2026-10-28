'use client';

import type { ReactNode } from 'react';
import { AuthStatus } from '@/components/ui/field';
import { cn } from '@/lib/cn';

export function AuthErrorCard({
  title,
  children,
  warning = false,
  lang,
}: {
  title: string;
  children?: ReactNode;
  warning?: boolean;
  lang?: string;
}) {
  return (
    <div
      className={cn('card p-5', warning ? 'border-warning' : 'border-error')}
      lang={lang}
      data-testid="auth-error-card"
    >
      <AuthStatus tone="error" className="mb-0">
        <p className="m-0 mb-1 text-[14px] font-semibold">{title}</p>
        {children ? <div className="text-[13px] text-body">{children}</div> : null}
      </AuthStatus>
    </div>
  );
}
