'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { configureContentQueryDefaults } from '@/features/items/query-keys';

export function QueryProvider({ children }: { children: ReactNode }) {
  // Tạo client trong state để mỗi request SSR có client riêng, không rò dữ liệu
  // giữa các người dùng.
  const [client] = useState(() => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    });
    configureContentQueryDefaults(queryClient);
    return queryClient;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
