import '@testing-library/jest-dom/vitest';

// Node 25 có Web Storage native dạng placeholder nhưng thiếu method khi không
// cấu hình --localstorage-file. Dùng storage mô phỏng có cùng contract trong test.
if (typeof window !== 'undefined') {
  let browserStorage: Storage | undefined;
  try {
    browserStorage = window.localStorage;
  } catch {
    // Một số engine ném lỗi ngay khi đọc storage của origin bị chặn.
  }

  const storage =
    browserStorage && typeof browserStorage.clear === 'function'
      ? browserStorage
      : (() => {
          const values = new Map<string, string>();
          return {
            get length() {
              return values.size;
            },
            clear() {
              values.clear();
            },
            getItem(key: string) {
              return values.get(String(key)) ?? null;
            },
            key(index: number) {
              return [...values.keys()][index] ?? null;
            },
            removeItem(key: string) {
              values.delete(String(key));
            },
            setItem(key: string, value: string) {
              values.set(String(key), String(value));
            },
          } satisfies Storage;
        })();

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
    writable: true,
  });
  if (globalThis !== window) {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
      writable: true,
    });
  }
}
