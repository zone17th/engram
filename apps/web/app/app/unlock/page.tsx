'use client';

import { Suspense } from 'react';
import { VaultUnlockFlow } from '@/features/vault/unlock';

export default function UnlockPage() {
  return (
    <Suspense fallback={null}>
      <VaultUnlockFlow />
    </Suspense>
  );
}
