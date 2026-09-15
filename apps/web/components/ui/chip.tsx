import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  count?: number;
  selected?: boolean;
}

/**
 * Selected dùng aria-pressed (mockup không có .chip-on).
 * Count render span muted — mockup không có .chip-count.
 */
export function Chip({ children, count, selected = false, className, ...props }: ChipProps) {
  return (
    <button type="button" aria-pressed={selected} className={cn('chip', className)} {...props}>
      <span>{children}</span>
      {count !== undefined && <span className="text-muted">{count}</span>}
    </button>
  );
}
