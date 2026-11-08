'use client';

import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { EmptyState } from '@/components/app-shell/empty-state';

/** U18 #err-server-500: translated, keeps the draft promise, one action (retry). */
export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('states');
  useEffect(() => {
    // Chỉ log tên lỗi. Message có thể chứa dữ liệu người dùng.
    console.error('app error:', error.name);
  }, [error]);

  return (
    <main className="mx-auto max-w-container px-5 py-16">
      <EmptyState title={t('server500Title')} body={t('server500Body')} action={{ label: t('retry'), onAction: reset }} />
    </main>
  );
}
