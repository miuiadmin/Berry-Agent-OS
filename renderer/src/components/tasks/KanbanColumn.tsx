import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TaskCard } from './TaskCard';
import type { Task, TaskColumn as ColumnType } from '@/lib/types';

interface Props {
  column: ColumnType;
  tasks: Task[];
  onAddTask: (columnId: string) => void;
}

function SortableTaskCard({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', task },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && 'opacity-50')}
      {...attributes}
      {...listeners}
    >
      <TaskCard task={task} />
    </div>
  );
}

export function KanbanColumn({ column, tasks, onAddTask }: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${column.id}`,
    data: { type: 'column', columnId: column.id },
  });

  const taskIds = tasks.map((t) => t.id);

  return (
    <div className="flex w-72 flex-shrink-0 flex-col rounded-lg bg-muted/50">
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          {column.color && (
            <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: column.color }} />
          )}
          <span className="text-sm font-medium">{column.name}</span>
          <span className="text-xs text-muted-foreground">{tasks.length}</span>
        </div>
        <button
          onClick={() => onAddTask(column.id)}
          className="rounded p-0.5 hover:bg-accent transition-colors"
        >
          <Plus className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 space-y-2 overflow-y-auto px-2 pb-2 min-h-[100px]',
          isOver && 'bg-accent/50 rounded-md'
        )}
      >
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableTaskCard key={task.id} task={task} />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}
