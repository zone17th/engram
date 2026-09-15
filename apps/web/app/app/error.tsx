'use client';

import { useEffect } from 'react';
import { EmptyState } from '@/components/app-shell/empty-state';

export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // Chỉ log tên lỗi. Message có thể chứa dữ liệu người dùng.
    console.error('app error:', error.name);
  }, [error]);

  return (
    <main className="mx-auto max-w-container px-5 py-16">
      <EmptyState title="Không tải được" body="Thử lại sau giây lát." action={{ label: 'Thử lại', onAction: reset }} />
    </main>
  );
}
