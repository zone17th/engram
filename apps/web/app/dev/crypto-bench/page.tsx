import { notFound } from 'next/navigation';
import { CryptoBenchClient } from './bench-client';

export interface CryptoBenchPageProps {
  searchParams?:
    | Promise<{ mode?: string | string[] }>
    | { mode?: string | string[] };
}

async function renderHarnessMode() {
  // Dynamic import required by task contract so the harness client (and CryptoClient -> worker.ts)
  // is only imported when `?mode=harness` is requested, keeping the owner benchmark mode isolated.
  const { CryptoHarnessClient } = await import('./harness-client');
  return (
    <html lang="en">
      <body>
        <CryptoHarnessClient />
      </body>
    </html>
  );
}

export default function CryptoBenchPage(props?: CryptoBenchPageProps) {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  const searchParams = props?.searchParams;
  if (searchParams) {
    if ('then' in searchParams && typeof searchParams.then === 'function') {
      return searchParams.then(async (resolved) => {
        if (resolved?.mode === 'harness') {
          return renderHarnessMode();
        }
        return (
          <html lang="en">
            <body>
              <CryptoBenchClient />
            </body>
          </html>
        );
      });
    }
    if ('mode' in searchParams && searchParams.mode === 'harness') {
      return renderHarnessMode();
    }
  }

  return (
    <html lang="en">
      <body>
        <CryptoBenchClient />
      </body>
    </html>
  );
}
