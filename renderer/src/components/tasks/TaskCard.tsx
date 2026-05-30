import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { Task } from '@/lib/types';

interface Props {
  task: Task;
}

const priorityConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  urgent: { label: '紧急', variant: 'destructive' },
  high: { label: '高', variant: 'destructive' },
  medium: { label: '中', variant: 'default' },
  low: { label: '低', variant: 'secondary' },
  none: { label: '', variant: 'outline' },
};

export function TaskCard({ task }: Props) {
  const priority = priorityConfig[task.priority] ?? priorityConfig.none;

  return (
    <div className={cn(
      'rounded-md border bg-card p-3 shadow-sm transition-shadow hover:shadow-md cursor-grab active:cursor-grabbing',
    )}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-tight line-clamp-2">{task.title}</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-mono">{task.identifier}</span>
        {task.priority !== 'none' && (
          <Badge variant={priority.variant} className="text-[10px] px-1.5 py-0">
            {priority.label}
          </Badge>
        )}
      </div>
      {task.assigneeId && (
        <div className="mt-1.5 text-xs text-muted-foreground truncate">
          {task.assigneeType === 'agent' ? '🤖' : '👤'} {task.assigneeId.slice(0, 8)}
        </div>
      )}
    </div>
  );
}
