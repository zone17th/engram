import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthChrome } from '@/features/auth/auth-chrome';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  other: { 'Referrer-Policy': 'no-referrer' },
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthChrome>{children}</AuthChrome>;
}
