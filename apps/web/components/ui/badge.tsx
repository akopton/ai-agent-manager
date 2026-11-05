import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Slot } from 'radix-ui';

const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default: 'bg-primary/15 text-primary [a]:hover:bg-primary/25',
        secondary: 'bg-secondary text-secondary-foreground [a]:hover:bg-hover',
        destructive:
          'bg-destructive/12 text-destructive focus-visible:ring-destructive/30 [a]:hover:bg-destructive/20',
        success: 'bg-success/12 text-success [a]:hover:bg-success/20',
        warning: 'bg-warning/12 text-warning [a]:hover:bg-warning/20',
        info: 'bg-info/12 text-info [a]:hover:bg-info/20',
        review: 'bg-review/15 text-review [a]:hover:bg-review/25',
        outline:
          'border-border-strong text-muted-foreground [a]:hover:bg-hover [a]:hover:text-foreground',
        ghost: 'hover:bg-hover hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

const Badge = ({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) => {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
};

export { Badge, badgeVariants };
