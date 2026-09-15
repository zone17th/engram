'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Chip } from '@/components/ui/chip';
import { Switch } from '@/components/ui/switch';

/**
 * `semanticAvailable` đến từ /api/v1/readyz. Khi EMBEDDING_PROVIDER=noop thì false
 * và toggle "Gần nghĩa" bị ẩn hoàn toàn — SPEC §7 ghi rõ `semantic_suggest` **ẩn**
 * khi `semantic_available = false`. Render nó ở trạng thái disabled vẫn là quảng
 * cáo một tính năng chưa có (P01 §Phạm vi), nên không làm.
 */
export function Rail({
  tags,
  semanticAvailable,
  recent = [],
}: {
  tags: { name: string; count: number }[];
  semanticAvailable: boolean;
  recent?: { id: string; title: string }[];
}) {
  const [semantic, setSemantic] = useState(false);

  return (
    <nav aria-label="Bộ lọc" className="hidden flex-col gap-8 lg:flex">
      <div>
        <p className="t-label mb-3 text-muted">Tag</p>
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <Chip key={tag.name} count={tag.count}>
              {tag.name}
            </Chip>
          ))}
        </div>
      </div>

      {recent.length > 0 ? (
        <div>
          <p className="t-label mb-3 text-muted">Gần đây</p>
          <div className="flex flex-col gap-0.5" aria-label="Mục gần đây">
            {recent.map((item) => (
              <Link
                key={item.id}
                href={`/app/items/${item.id}`}
                className="flex items-baseline gap-2 rounded-md px-2 py-2 text-body no-underline hover:bg-surface"
              >
                <span className="min-w-0 truncate text-[15px]">{item.title}</span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {semanticAvailable ? (
        <div className="rounded-xl bg-surface p-4">
          <p className="t-label mb-2 text-muted">Gần nghĩa</p>
          <div className="flex items-center gap-3">
            <Switch checked={semantic} onCheckedChange={setSemantic} label="Gần nghĩa" />
          </div>
          <p className="t-legal mt-2 text-muted">Chỉ bật khi máy chủ nhúng sẵn sàng.</p>
        </div>
      ) : null}
    </nav>
  );
}
