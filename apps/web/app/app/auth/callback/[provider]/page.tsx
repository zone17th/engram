import { Suspense } from 'react';
import { OAuthCallbackView } from '@/features/auth/forms/oauth-callback';

export default async function OAuthCallbackPage({
  params,
}: {
  params: Promise<{ provider: string }>;
}) {
  const { provider } = await params;
  return (
    <Suspense fallback={null}>
      <OAuthCallbackView provider={provider} />
    </Suspense>
  );
}
