// 'use client' là bắt buộc: useId() là hook, không chạy trong server component.
'use client';

import { useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * Logo luôn đi kèm chữ `engram` viết thường (P01-A6). SVG chép nguyên từ
 * mockups/landing.html (và index.html): rect + path dấu vết magenta→cyan.
 * id gradient dùng useId() để không trùng khi render nhiều logo trên một trang.
 */
export function Logo({ className }: { className?: string }) {
  const gradientId = useId();
  return (
    <span className={cn('inline-flex items-center gap-2.5 text-ink', className)}>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1="5"
            y1="17"
            x2="23"
            y2="11"
          >
            <stop offset="0%" stopColor="var(--logo-magenta)" />
            <stop offset="100%" stopColor="var(--logo-cyan)" />
          </linearGradient>
        </defs>
        <rect width="28" height="28" rx="9" fill="var(--logo-ink)" />
        <path
          d="M5.5 16C11 16 16.5 12 22.5 12"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeDasharray="0.1 5.2 0.1 4 20"
        />
      </svg>
      <span className="font-display text-[19px] font-extrabold tracking-[-.04em]">engram</span>
    </span>
  );
}
