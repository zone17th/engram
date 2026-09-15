import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/** Khớp mockups/states.html — dùng cho cả rỗng, lỗi và offline. */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onAction: () => void };
}) {
  return (
    <Card className="flex flex-col items-start gap-3 p-8">
      <h2 className="t-title-md text-ink">{title}</h2>
      <p className="text-muted">{body}</p>
      {action && (
        <Button variant="secondary" onClick={action.onAction}>
          {action.label}
        </Button>
      )}
    </Card>
  );
}
