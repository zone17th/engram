'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn('dialog-overlay', className)}
      {...props}
    />
  );
});

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function DialogContent({ className, children, ...props }, ref) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn('dialog-content', className)}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

export function DialogHeader({
  title,
  description,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <header className={className}>
      <DialogPrimitive.Title className="t-title-sm mb-1">{title}</DialogPrimitive.Title>
      {description != null && (
        <DialogPrimitive.Description className="t-body mb-0 text-muted">
          {description}
        </DialogPrimitive.Description>
      )}
    </header>
  );
}

export interface DialogFooterProps {
  children: ReactNode;
  className?: string;
}

export function DialogFooter({ children, className }: DialogFooterProps) {
  return <div className={cn('flex justify-end gap-2', className)}>{children}</div>;
}

/**
 * Escape và nút Huỷ: khi pending, onOpenChange(false) bị chặn;
 * caller truyền pending=true và onDismissAttempt nếu cần toast.
 */
export function useDialogDismissGuard(pending: boolean) {
  return (open: boolean) => {
    if (!open && pending) return false;
    return true;
  };
}
