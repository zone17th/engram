'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { type ReadyResponse, apiFetch } from '@engram/shared-types';
import { AppHeader } from '@/components/app-shell/app-header';
import { EmptyState } from '@/components/app-shell/empty-state';
import { Omnibox } from '@/components/app-shell/omnibox';
import { PreviewNotice } from '@/components/app-shell/preview-notice';
import { Rail } from '@/components/app-shell/rail';
import { BadgeType } from '@/components/ui/badge-type';
import { DEMO_ITEMS, DEMO_TAGS } from '@/lib/demo-fixtures';

export default function AppPage() {
  // Nguồn duy nhất cho cờ semantic: readyz của API, không phải biến build của web.
  const ready = useQuery({
    queryKey: ['readyz'],
    queryFn: () => apiFetch<ReadyResponse>('/readyz'),
  });

  const semanticAvailable = ready.data?.semantic_available ?? false;

  return (
    <>
      {/* Chưa có vault thật — pill nhận dữ liệu mẫu của shell. */}
      <AppHeader vault={{ state: 'locked' }} />

      <main className="mx-auto grid max-w-container gap-8 px-5 py-8 lg:grid-cols-[236px_minmax(0,1fr)]">
        <Rail
          tags={DEMO_TAGS}
          semanticAvailable={semanticAvailable}
          recent={DEMO_ITEMS.slice(0, 5).map((item) => ({
            id: item.id,
            title: item.title,
          }))}
        />

        <section aria-labelledby="recent-heading" className="flex flex-col gap-4">
          <PreviewNotice />
          <div>
            <h1 className="t-title-lg text-ink">Gõ để tìm. Gõ tiếp để lưu.</h1>
            <p className="t-body-lg mt-1 text-muted">Thử tìm trong các mục mẫu. Nội dung bạn gõ không được lưu.</p>
          </div>
          <Omnibox />
          <p className="t-caption text-muted">
            Thử: <span className="mono">ca phe</span> · <span className="mono">ghi chu</span> · <span className="mono">cau hinh</span>
          </p>

          <div className="mt-8 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="recent-heading" className="t-title-sm text-ink">
              Mục gần đây
            </h2>
            <span className="mono text-[13px] text-muted">{DEMO_ITEMS.length} mục mẫu</span>
          </div>

          {DEMO_ITEMS.length === 0 ? (
            <EmptyState title="Chưa có mục mẫu ở đây" body="Bản xem trước không có dữ liệu để hiển thị." />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {DEMO_ITEMS.map((item) => (
                <Link
                  key={item.id}
                  href={`/app/items/${item.id}`}
                  className="card flex flex-col gap-2 p-5 no-underline !text-body"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-display font-bold text-ink">{item.title}</h2>
                    <BadgeType kind={item.kind} />
                  </div>
                  <p className="t-legal text-muted">{item.preview}</p>
                  <span className="t-caption mt-auto text-link">Xem bản xem trước →</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
