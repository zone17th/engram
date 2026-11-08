'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { cn } from '@/lib/cn';

export interface DialogProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Root> {
  returnFocusRef?: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  dismissible?: boolean;
}

interface DialogContextValue {
  returnFocusRef?: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  dismissible?: boolean;
  openerRef?: RefObject<HTMLElement | null>;
}

const DialogContext = createContext<DialogContextValue>({});

export function Dialog({
  open,
  onOpenChange,
  returnFocusRef,
  initialFocusRef,
  dismissible,
  children,
  ...props
}: DialogProps) {
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);

  const ctxValue = useMemo<DialogContextValue>(
    () => ({ returnFocusRef, initialFocusRef, dismissible, openerRef }),
    [returnFocusRef, initialFocusRef, dismissible],
  );

  return (
    <DialogContext.Provider value={ctxValue}>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} {...props}>
        {children}
      </DialogPrimitive.Root>
    </DialogContext.Provider>
  );
}
export const DialogTrigger = forwardRef<
  ElementRef<typeof DialogPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>(function DialogTrigger({ className, ...props }, ref) {
  return <DialogPrimitive.Trigger ref={ref} className={cn('touch-target', className)} {...props} />;
});
DialogTrigger.displayName = 'DialogTrigger';

export const DialogClose = forwardRef<
  ElementRef<typeof DialogPrimitive.Close>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(function DialogClose({ className, ...props }, ref) {
  return <DialogPrimitive.Close ref={ref} className={cn('touch-target', className)} {...props} />;
});
DialogClose.displayName = 'DialogClose';
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

export interface DialogContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  returnFocusRef?: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  dismissible?: boolean;
}

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent(
  {
    className,
    children,
    returnFocusRef: propReturnFocusRef,
    initialFocusRef: propInitialFocusRef,
    dismissible: propDismissible,
    onOpenAutoFocus,
    onCloseAutoFocus,
    onEscapeKeyDown,
    onPointerDownOutside,
    onInteractOutside,
    ...props
  },
  ref,
) {
  const ctx = useContext(DialogContext);
  const returnFocusRef = propReturnFocusRef ?? ctx.returnFocusRef;
  const initialFocusRef = propInitialFocusRef ?? ctx.initialFocusRef;
  const dismissible = propDismissible ?? ctx.dismissible ?? true;

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn('dialog-content', className)}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const initialTarget = initialFocusRef?.current;
          if (initialTarget && initialTarget.isConnected) {
            event.preventDefault();
            initialTarget.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const opener = returnFocusRef?.current ?? ctx.openerRef?.current;
          if (opener && opener.isConnected) {
            event.preventDefault();
            opener.focus();
          }
        }}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (!dismissible) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          onPointerDownOutside?.(event);
          if (!dismissible) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          if (!dismissible) {
            event.preventDefault();
          }
        }}
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
