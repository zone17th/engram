import { Inter, Plus_Jakarta_Sans, Sometype_Mono } from 'next/font/google';

// next/font tải font lúc build và phục vụ từ chính origin — bắt buộc để hợp CSP
// `default-src 'self'` (SPEC §10.2). Giao diện giữ nguyên như mockup.
//
// File này tồn tại vì có HAI root layout (marketing và /app) cùng cần font.
// Gọi next/font ở hai nơi sẽ tải hai bản, mỗi bản một class hash khác nhau.
const display = Plus_Jakarta_Sans({ subsets: ['latin', 'vietnamese'], variable: '--font-plus-jakarta', display: 'swap' });
const sans = Inter({ subsets: ['latin', 'vietnamese'], variable: '--font-inter', display: 'swap' });
const mono = Sometype_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-sometype', display: 'swap' });

export const fontVariables = `${display.variable} ${sans.variable} ${mono.variable}`;
