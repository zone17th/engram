import Link from 'next/link';
import { Card } from '@/components/ui/card';

/**
 * not-found là server component: không dùng EmptyState (EmptyState nhận onAction
 * nên phải là client), và không dùng <Button> (Task 12 không có `asChild`, lồng
 * <a> trong <button> là HTML sai). Dùng thẳng class `btn` của tokens.css.
 */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-container px-5 py-16">
      <Card className="flex flex-col items-start gap-3 p-8">
        <h1 className="t-title-md m-0">Không có trang này</h1>
        <p className="t-body m-0 text-muted">Đường dẫn bạn mở không tồn tại hoặc đã đổi.</p>
        <Link href="/" className="btn btn-secondary no-underline">
          Về trang chủ
        </Link>
      </Card>
    </main>
  );
}
