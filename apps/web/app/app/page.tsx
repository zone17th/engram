'use client';

import { useQuery } from '@tanstack/react-query';
import { type ReadyResponse, apiFetch } from '@engram/shared-types';
import { AppHeader } from '@/components/app-shell/app-header';
import { EmptyState } from '@/components/app-shell/empty-state';
import { Rail } from '@/components/app-shell/rail';
import { BadgeType } from '@/components/ui/badge-type';
import { Card } from '@/components/ui/card';
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
      {/* P01 chưa có vault thật — pill nhận fixture của shell (P03 nối state thật). */}
      <AppHeader vault={{ state: 'locked' }} />

      <main className="mx-auto grid max-w-container gap-8 px-5 py-8 lg:grid-cols-[236px_minmax(0,1fr)]">
        <Rail tags={DEMO_TAGS} semanticAvailable={semanticAvailable} />

        <section aria-labelledby="recent-heading" className="flex flex-col gap-4">
          <h1 id="recent-heading" className="t-title-sm text-ink">
            Mục gần đây
          </h1>

          {DEMO_ITEMS.length === 0 ? (
            <EmptyState title="Chưa có gì ở đây" body="Lưu mục đầu tiên bằng cách gõ từ khoá rồi nhấn Enter." />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {DEMO_ITEMS.map((item) => (
                <Card key={item.id} className="flex flex-col gap-2 p-5">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-display font-bold text-ink">{item.title}</h2>
                    <BadgeType kind={item.kind} />
                  </div>
                  <p className="t-legal text-muted">{item.preview}</p>
                </Card>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
