'use client';

import { cn } from '@/lib/cn';

/** Toast tĩnh: hiển thị thông báo + một hành động. Không tự hẹn giờ đóng ở P01.
 * Action là <button> trần — style bởi .toast button trong tokens.css (không gắn .btn).
 */
export function Toast({
  message,
  action,
  className,
}: {
  message: string;
  action?: { label: string; onAction: () => void };
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" className={cn('toast', className)}>
      <span>{message}</span>
      {action && (
        <button type="button" onClick={action.onAction}>
          {action.label}
        </button>
      )}
    </div>
  );
}
