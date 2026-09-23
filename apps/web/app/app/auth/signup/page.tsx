import { Suspense } from 'react';
import { SignupForm } from '@/features/auth/forms/signup-form';

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}
