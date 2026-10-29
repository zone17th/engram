import { notFound } from 'next/navigation';
import { CryptoBenchClient } from './bench-client';

export default function CryptoBenchPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return (
    <html lang="en">
      <body>
        <CryptoBenchClient />
      </body>
    </html>
  );
}
