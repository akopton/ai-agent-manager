import type { ComponentProps } from 'react';
import type { TaskAction } from '@ai-agent-manager/core';

import { Button } from '@/components/ui/button';
import { lifecycleActionStatus, taskStatusStyle } from '@/lib/tasks/status-style';

/** Destructive actions retain their destructive styling rather than a destination tint. */
export const LifecycleButton = ({
  action,
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant' | 'style'> & { action: TaskAction }) => (
  <Button
    {...props}
    variant={action === 'discard' || action === 'stop' ? 'destructive' : 'lifecycle'}
    data-destination-status={lifecycleActionStatus(action)}
    style={taskStatusStyle(lifecycleActionStatus(action))}
  />
);
