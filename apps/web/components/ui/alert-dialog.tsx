'use client';

import * as React from 'react';
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

// A minimal shadcn-style alert dialog built on the Radix primitive (focus trap, Escape to close,
// and accessible title/description wiring are provided by Radix).

const AlertDialog = (props: React.ComponentProps<typeof AlertDialogPrimitive.Root>) => (
  <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
);

const AlertDialogTrigger = (props: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) => (
  <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
);

const AlertDialogContent = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) => (
  <AlertDialogPrimitive.Portal>
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className="fixed inset-0 z-50 bg-black/40 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
    />
    <AlertDialogPrimitive.Content
      data-slot="alert-dialog-content"
      className={cn(
        'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border bg-background p-6 text-sm shadow-lg data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
        className,
      )}
      {...props}
    />
  </AlertDialogPrimitive.Portal>
);

const AlertDialogHeader = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="alert-dialog-header" className={cn('grid gap-2', className)} {...props} />
);

const AlertDialogFooter = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="alert-dialog-footer"
    className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
    {...props}
  />
);

const AlertDialogTitle = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) => (
  <AlertDialogPrimitive.Title
    data-slot="alert-dialog-title"
    className={cn('text-lg font-semibold break-words', className)}
    {...props}
  />
);

const AlertDialogDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) => (
  <AlertDialogPrimitive.Description
    data-slot="alert-dialog-description"
    className={cn('text-muted-foreground', className)}
    {...props}
  />
);

const AlertDialogCancel = (props: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) => (
  <AlertDialogPrimitive.Cancel data-slot="alert-dialog-cancel" {...props} />
);

export {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
};
