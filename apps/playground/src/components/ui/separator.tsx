import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

function Separator({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="separator"
      role="separator"
      className={cn('bg-border h-px w-full shrink-0', className)}
      {...props}
    />
  );
}

export { Separator };
