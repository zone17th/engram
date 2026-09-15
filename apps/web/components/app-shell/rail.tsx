'use client';

import { useState } from 'react';
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
}: {
  tags: { name: string; count: number }[];
  semanticAvailable: boolean;
}) {
  const [semantic, setSemantic] = useState(false);

  return (
    <nav aria-label="Bộ lọc" className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <Chip key={tag.name} count={tag.count}>
            {tag.name}
          </Chip>
        ))}
      </div>

      {semanticAvailable ? (
        <Switch checked={semantic} onCheckedChange={setSemantic} label="Gần nghĩa" />
      ) : null}
    </nav>
  );
}
