import * as React from 'react';
import { cn } from '@/lib/utils';

const fieldClassName =
  'h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 py-1 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20';

const Input = ({ className, type, ...props }: React.ComponentProps<'input'>) => {
  return (
    <input type={type} data-slot="input" className={cn(fieldClassName, className)} {...props} />
  );
};

/** A native select styled like `Input`; keeps keyboard and screen reader behavior built in. */
const NativeSelect = ({ className, ...props }: React.ComponentProps<'select'>) => {
  return <select data-slot="native-select" className={cn(fieldClassName, className)} {...props} />;
};

export { Input, NativeSelect };
