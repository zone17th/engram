'use client';

import { useRef } from 'react';
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
}: {
  options: SegmentedOption[];
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabIndex = selectedIndex >= 0 ? selectedIndex : 0;

  function moveTo(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    tabRefs.current[index]?.focus();
  }

  return (
    <div role="tablist" className={cn('seg', className)}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={index === tabIndex ? 0 : -1}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              let nextIndex: number | null = null;
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                nextIndex = (index + 1) % options.length;
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                nextIndex = (index - 1 + options.length) % options.length;
              } else if (event.key === 'Home') {
                nextIndex = 0;
              } else if (event.key === 'End') {
                nextIndex = options.length - 1;
              }

              if (nextIndex === null || nextIndex === index) return;
              event.preventDefault();
              moveTo(nextIndex);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
