'use client';

import { useTranslations } from 'next-intl';

/**
 * F-06: first Tab stop on every app page. Jumps to `<main id="main-content">`. Same visual rule as the
 * landing/docs skip link (`sr-only` until focused, then a fixed pill).
 */
export function SkipLink() {
  const t = useTranslations('nav');
  return (
    <a
      href="#main-content"
      data-testid="skip-link"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-line focus:bg-canvas focus:px-4 focus:py-2 focus:font-semibold focus:!text-body"
    >
      {t('skipToContent')}
    </a>
  );
}
