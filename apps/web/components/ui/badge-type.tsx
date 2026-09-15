import { cn } from '@/lib/cn';

/** TEXT/JSON badge của mục lưu trữ — màu do .badge-text/.badge-json quyết định. */
export function BadgeType({ kind, className }: { kind: 'text' | 'json'; className?: string }) {
  return (
    <span className={cn('badge-type', kind === 'json' ? 'badge-json' : 'badge-text', className)}>
      {kind.toUpperCase()}
    </span>
  );
}
