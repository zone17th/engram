'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';

/** U18 #err-not-found for unknown /app/* paths: translated through the app layout's provider, one action back to the list. */
export default function AppNotFound() {
  const t = useTranslations('states');
  return (
    <main id="main-content" className="mx-auto max-w-container px-5 py-16">
      <Card className="flex flex-col items-start gap-3 p-8" data-testid="err-not-found">
        <h1 className="t-title-md m-0">{t('notFoundTitle')}</h1>
        <p className="t-body m-0 text-muted">{t('notFoundBody')}</p>
        <Link href="/app" className="btn btn-secondary no-underline">
          {t('backToList')}
        </Link>
      </Card>
    </main>
  );
}
