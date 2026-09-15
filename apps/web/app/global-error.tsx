'use client';

import { useEffect } from 'react';
import { EmptyState } from '@/components/app-shell/empty-state';

/**
 * Boundary cuối: bắt lỗi ném ra từ chính root layout, tức cả hai root layout đều
 * đã hỏng. Vì layout hỏng nên KHÔNG có <html>/<body> nào ở trên — `global-error`
 * là file duy nhất được phép (và bắt buộc) tự render chúng.
 *
 * Nằm ngoài mọi NextIntlClientProvider nên chuỗi viết thẳng tiếng Việt — mặc
 * định của site. Không dùng fontVariables: nếu lỗi đến từ font thì càng phải
 * hiển thị được.
 */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // Chỉ log tên lỗi. Message có thể chứa dữ liệu người dùng.
    console.error('global error:', error.name);
  }, [error]);

  return (
    <html lang="vi" data-theme="light">
      <body className="bg-canvas font-sans text-body antialiased">
        <main className="mx-auto max-w-container px-5 py-16">
          <EmptyState
            title="Không tải được"
            body="Thử lại sau giây lát."
            action={{ label: 'Thử lại', onAction: reset }}
          />
        </main>
      </body>
    </html>
  );
}
