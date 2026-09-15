import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  tone?: 'default' | 'agent';
}

export function Panel({ tone = 'default', className, ...props }: PanelProps) {
  return <div className={cn(tone === 'agent' ? 'panel-agent' : 'panel', className)} {...props} />;
}
