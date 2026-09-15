import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AppHeader } from '@/components/app-shell/app-header';
import { PreviewNotice } from '@/components/app-shell/preview-notice';
import { BadgeType } from '@/components/ui/badge-type';
import { DEMO_ITEMS } from '@/lib/demo-fixtures';

export default async function ItemPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = DEMO_ITEMS.find((candidate) => candidate.id === id);
  if (!item) notFound();

  return (
    <>
      <AppHeader vault={{ state: 'locked' }} showSearch />
      <main className="mx-auto max-w-container px-5 pb-28 pt-8">
        <nav aria-label="Đường dẫn" className="mb-5 text-[13px] text-muted">
          <Link href="/app" className="no-underline">
            Tất cả mục
          </Link>
          <span className="mx-1.5">/</span>
          <span>{item.title}</span>
        </nav>

        <PreviewNotice className="mb-7" />

        <div className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="t-title-lg text-ink">{item.title}</h1>
              <BadgeType kind={item.kind} />
            </div>
            <p className="t-body mt-1 text-muted">Mục này chỉ đọc trong bản xem trước.</p>
          </div>
        </div>

        <div className="mb-8 flex flex-wrap items-center gap-2">
          {item.tags.map((tag) => (
            <span key={tag} className="chip cursor-default">
              #{tag}
            </span>
          ))}
          <span className="mono ml-1 text-[13px] text-muted">1 nội dung · dữ liệu mẫu</span>
        </div>

        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_248px]">
          <article className="card overflow-hidden">
            <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
              <BadgeType kind={item.kind} />
              <span className="text-[15px] font-semibold">Nội dung mẫu</span>
            </header>
            <div className="p-5">
              {item.kind === 'json' ? (
                <pre className="json-raw overflow-x-auto rounded-md">{item.preview}</pre>
              ) : (
                <p className="m-0 text-[15px] leading-relaxed text-body">{item.preview}</p>
              )}
            </div>
            <footer className="border-t border-line px-4 py-2 text-[12px] text-muted">Chỉ đọc · dữ liệu công khai</footer>
          </article>

          <aside className="panel-agent p-5">
            <h2 className="t-title-sm mb-2 text-ink">Giới hạn bản xem trước</h2>
            <p className="t-body m-0 text-muted">
              Các thao tác chỉnh sửa, nhập và xuất chưa khả dụng. Màn này chỉ đọc.
            </p>
          </aside>
        </div>
      </main>
    </>
  );
}
