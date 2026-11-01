import { redirect } from 'next/navigation';
import { ItemDetailPage } from '@/features/items/item-detail-page';
import { contentEnabled } from '@/lib/flags';

export default async function ItemPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  if (!contentEnabled()) {
    redirect('/app');
  }
  const { id } = await params;
  return <ItemDetailPage itemId={id} />;
}
