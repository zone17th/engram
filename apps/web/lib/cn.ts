import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Ghép class: clsx cho điều kiện, twMerge để utility sau thắng utility trước. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
