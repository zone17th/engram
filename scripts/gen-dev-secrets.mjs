#!/usr/bin/env node
// Sinh năm secret base64 độc lập ra stdout. Không ghi file; copy vào .env thủ công.
import { randomBytes } from 'node:crypto';

const names = [
  'AUTH_JWT_SECRET',
  'AUTH_CSRF_SECRET',
  'AUTH_REAUTH_SECRET',
  'AUTH_IP_PEPPER',
  'AUTH_EMAIL_PEPPER',
];
for (const name of names) {
  console.log(`${name}=${randomBytes(32).toString('base64')}`);
}
