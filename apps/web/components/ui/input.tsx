import * as React from 'react';
import { cn } from '@/lib/utils';

const fieldClassName =
  'h-9 w-full min-w-0 rounded-lg border border-input bg-inset px-2.5 py-1 text-sm text-foreground transition-colors outline-none placeholder:text-muted-foreground/70 hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-border disabled:bg-disabled disabled:text-disabled-foreground aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20';

const Input = ({ className, type, ...props }: React.ComponentProps<'input'>) => {
  return (
    <input type={type} data-slot="input" className={cn(fieldClassName, className)} {...props} />
  );
};

/** A native select styled like `Input`; keeps keyboard and screen reader behavior built in. */
const NativeSelect = ({ className, ...props }: React.ComponentProps<'select'>) => {
  return <select data-slot="native-select" className={cn(fieldClassName, className)} {...props} />;
};

/** A multi-line text field styled like `Input`. */
const Textarea = ({ className, ...props }: React.ComponentProps<'textarea'>) => {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClassName, 'h-auto min-h-32 py-2 leading-6', className)}
      {...props}
    />
  );
};

export { Input, NativeSelect, Textarea };
