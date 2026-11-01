import { Suspense } from 'react';
import { ResetPasswordForm } from '@/features/auth/forms/reset-password-form';

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
