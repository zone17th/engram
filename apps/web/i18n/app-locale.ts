/**
 * Locale của `/app` ở P01. Hằng số chứ không hardcode rải rác: `<html lang>` và
 * `NextIntlClientProvider` phải luôn khớp nhau, lệch một cái là screen reader
 * đọc sai giọng.
 *
 * P02 thay hằng này bằng locale đọc từ hồ sơ người dùng (sau khi có session).
 * Ghi vào nợ kỹ thuật ở Task 18.
 */
export const APP_LOCALE = 'vi' as const;
