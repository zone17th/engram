import { cn } from '@/lib/cn';

/** Keep the read-only boundary visible in every preview surface. */
export function PreviewNotice({ className }: { className?: string }) {
  return (
    <aside className={cn('panel-agent flex items-start gap-3 p-4', className)} role="status">
      <span className="mono shrink-0 text-[11px] font-medium text-accent">Bản xem trước</span>
      <p className="t-caption m-0 text-body">
        Đây là dữ liệu mẫu để xem giao diện. Bản xem trước chỉ đọc: thay đổi không được lưu và nội dung không được gửi tới máy chủ.
      </p>
    </aside>
  );
}
