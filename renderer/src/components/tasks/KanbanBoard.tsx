import { useState, useCallback } from 'react';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { KanbanColumn } from './KanbanColumn';
import { TaskCard } from './TaskCard';
import { useMoveTask } from '@/hooks/use-tasks';
import type { Task, TaskColumn } from '@/lib/types';

interface Props {
  columns: TaskColumn[];
  tasks: Task[];
  onAddTask: (columnId: string) => void;
}

export function KanbanBoard({ columns, tasks, onAddTask }: Props) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const moveTask = useMoveTask();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find((t) => t.id === active.id);
    if (task) setActiveTask(task);
  }, [tasks]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as string;
    const overData = over.data.current;

    let targetColumnId: string | null = null;

    if (overData?.type === 'column') {
      targetColumnId = overData.columnId;
    } else if (overData?.type === 'task') {
      const overTask = overData.task as Task;
      targetColumnId = overTask.columnId;
    }

    if (!targetColumnId) return;

    const task = tasks.find((t) => t.id === taskId);
    if (task && task.columnId !== targetColumnId) {
      moveTask.mutate({ id: taskId, columnId: targetColumnId });
    }
  }, [tasks, moveTask]);

  const sortedColumns = [...columns].sort((a, b) => a.position - b.position);

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {sortedColumns.map((col) => (
          <KanbanColumn
            key={col.id}
            column={col}
            tasks={tasks.filter((t) => t.columnId === col.id).sort((a, b) => a.position - b.position)}
            onAddTask={onAddTask}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask && <TaskCard task={activeTask} />}
      </DragOverlay>
    </DndContext>
  );
}
