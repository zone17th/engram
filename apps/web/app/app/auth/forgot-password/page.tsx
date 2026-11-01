import { Suspense } from 'react';
import { ForgotPasswordForm } from '@/features/auth/forms/forgot-password-form';

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
