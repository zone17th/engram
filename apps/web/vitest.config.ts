import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': root,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'tests/**/*.test.{ts,tsx}',
      'lib/**/*.test.ts',
      'features/settings/security/vault/**/*.test.{ts,tsx}',
      'features/{items,entries,json-table,omnibox,tags}/**/*.test.{ts,tsx}',
      'components/**/*.test.{ts,tsx}',
    ],
    setupFiles: ['./tests/setup.ts'],
    unstubEnvs: true,
  },
});
