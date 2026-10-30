import localFont from 'next/font/local';

// Cùng các file woff2 dưới tên font thật, cho những rule của tokens.css viết thẳng
// 'Inter' / 'Plus Jakarta Sans' / 'Sometype Mono' (xem đầu families.css).
import './fonts/families.css';

// Font nằm sẵn trong repo (app/fonts/, nguồn và sha256 ở README.md cạnh đó) và
// next/font phục vụ từ chính origin — bắt buộc để hợp CSP `default-src 'self'`
// (SPEC §10.2). Không dùng next/font/google: bản build tải font từ Google lúc
// build và thỉnh thoảng hỏng khi Google trả URL động (advisor-dec-052).
// Giao diện giữ nguyên như mockup.
//
// File này tồn tại vì có HAI root layout (marketing và /app) cùng cần font.
// Gọi next/font ở hai nơi sẽ tải hai bản, mỗi bản một class hash khác nhau.
const display = localFont({
  src: './fonts/PlusJakartaSans-Variable.woff2',
  weight: '200 800',
  variable: '--font-plus-jakarta',
  display: 'swap',
});
const sans = localFont({
  src: './fonts/Inter-Variable.woff2',
  weight: '100 900',
  variable: '--font-inter',
  display: 'swap',
});
const mono = localFont({
  src: './fonts/SometypeMono-Variable.woff2',
  weight: '400 500',
  variable: '--font-sometype',
  display: 'swap',
});

export const fontVariables = `${display.variable} ${sans.variable} ${mono.variable}`;
