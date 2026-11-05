import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[1rem_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-card-foreground [&>svg]:text-muted-foreground',
        info: 'border-info/25 bg-info/8 text-foreground [&>svg]:text-info',
        success: 'border-success/25 bg-success/8 text-foreground [&>svg]:text-success',
        warning:
          'border-warning/30 bg-warning/8 text-foreground *:data-[slot=alert-title]:text-warning [&>svg]:text-warning',
        destructive:
          'border-destructive/30 bg-destructive/8 text-foreground *:data-[slot=alert-title]:text-destructive [&>svg]:text-destructive',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

const Alert = ({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) => {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
};

const AlertTitle = ({ className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      data-slot="alert-title"
      className={cn('col-start-2 min-h-4 font-medium tracking-tight', className)}
      {...props}
    />
  );
};

const AlertDescription = ({ className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed',
        className,
      )}
      {...props}
    />
  );
};

export { Alert, AlertTitle, AlertDescription };
