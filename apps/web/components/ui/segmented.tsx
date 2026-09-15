'use client';

import { cn } from '@/lib/cn';

export interface SegmentedOption {
  value: string;
  label: string;
}

/**
 * Mockup dùng .seg button[aria-pressed='true'] — không có .seg-btn/.seg-on.
 * Giữ role=tablist/tab + aria-selected cho a11y theo plan test; đồng thời
 * set aria-pressed để CSS tokens áp được.
 */
export function Segmented({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentedOption[];
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn('seg', className)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-pressed={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
