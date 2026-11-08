'use client';

import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';

function useSegmentedDefaultAriaLabel(): string {
  try {
    const t = useTranslations('ui');
    return t('segmentedAriaLabel');
  } catch {
    if (typeof document !== 'undefined' && document.documentElement.lang === 'vi') {
      return 'Lựa chọn';
    }
    return 'Options';
  }
}
export interface SegmentedOption {
  value: string;
  label: string;
}

export function Segmented({
  options,
  value,
  onChange,
  className,
  disabled,
  ariaLabel,
}: {
  options: SegmentedOption[];
  value: string;
  onChange: (next: string) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const defaultAriaLabel = useSegmentedDefaultAriaLabel();
  const resolvedAriaLabel = ariaLabel ?? defaultAriaLabel;
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      disabled={disabled}
      className={cn('seg', className)}
      aria-label={resolvedAriaLabel}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className="touch-target font-semibold text-[13px] max-sm:min-h-11 max-sm:min-w-11"
          aria-label={option.label}
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
