'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';

/**
 * Keep the read-only boundary visible in every preview surface.
 *
 * Client component on purpose: `/app` resolves its locale from the cookie in app/app/layout.tsx and hands it to
 * NextIntlClientProvider. The server request config (i18n/request.ts) only knows the marketing route locale, so a
 * server `getTranslations` here could show en copy to a vi user.
 */
export function PreviewNotice({ className }: { className?: string }) {
  const t = useTranslations('app.preview');
  return (
    <aside className={cn('panel-agent flex items-start gap-3 p-4', className)} role="status">
      <span className="mono shrink-0 text-[11px] font-medium text-accent">{t('label')}</span>
      <p className="t-caption m-0 text-body">{t('body')}</p>
    </aside>
  );
}
