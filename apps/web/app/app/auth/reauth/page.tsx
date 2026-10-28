import { Suspense } from 'react';
import { ReauthForm } from '@/features/auth/forms/reauth-form';

export default function ReauthPage() {
  return (
    <Suspense fallback={null}>
      <ReauthForm />
    </Suspense>
  );
}
