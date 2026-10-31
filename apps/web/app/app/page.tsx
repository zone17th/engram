'use client';

import { useQuery } from '@tanstack/react-query';
import { type ReadyResponse, apiFetch } from '@engram/shared-types';
import { AppHeader } from '@/components/app-shell/app-header';
import { EmptyState } from '@/components/app-shell/empty-state';
import { Omnibox } from '@/components/app-shell/omnibox';
import { Rail } from '@/components/app-shell/rail';
import { useSession } from '@/features/auth/session-provider';
import { ItemList } from '@/features/items/item-list';
import { LockedBanner } from '@/features/items/locked-banner';
import { DEMO_ITEMS, DEMO_TAGS } from '@/lib/demo-fixtures';

export default function AppPage() {
  const { me, status } = useSession();
  // Nguồn duy nhất cho cờ semantic: readyz của API, không phải biến build của web.
  const ready = useQuery({
    queryKey: ['readyz'],
    queryFn: () => apiFetch<ReadyResponse>('/readyz'),
  });

  const semanticAvailable = me?.features.semantic_available ?? ready.data?.semantic_available ?? false;
  const vaultState = me?.vault.status === 'present' ? 'locked' : 'absent';

  if (status === 'loading') return null;

  return (
    <>
      <AppHeader vault={{ state: vaultState }} showLogout />
      <LockedBanner />

      <main className="mx-auto grid max-w-container gap-8 px-5 py-8 lg:grid-cols-[236px_minmax(0,1fr)]">
        <Rail
          tags={DEMO_TAGS}
          semanticAvailable={semanticAvailable}
          recent={DEMO_ITEMS.slice(0, 5).map((item) => ({
            id: item.id,
            title: item.title,
          }))}
        />

        <section aria-labelledby="recent-heading" className="flex min-w-0 flex-col gap-4">
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
            <ItemList items={DEMO_ITEMS} openLabel="Xem bản xem trước →" />
          )}
        </section>
      </main>
    </>
  );
}
