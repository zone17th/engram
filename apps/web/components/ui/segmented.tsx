'use client';

import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { cn } from '@/lib/cn';

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
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      disabled={disabled}
      className={cn('seg', className)}
      aria-label={ariaLabel ?? 'Lựa chọn'}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className="touch-target font-semibold text-[13px]"
          aria-label={option.label}
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
