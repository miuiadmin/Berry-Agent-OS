import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { KanbanBoard } from '@/components/tasks/KanbanBoard';
import { CreateProjectDialog } from '@/components/tasks/CreateProjectDialog';
import { CreateTaskDialog } from '@/components/tasks/CreateTaskDialog';
import { useWorkspaces } from '@/hooks/use-workspaces';
import { useProjects, useProjectColumns } from '@/hooks/use-projects';
import { useTasks } from '@/hooks/use-tasks';

const USER_ID = 'default-user';

export function TasksPage() {
  const { data: workspaces } = useWorkspaces(USER_ID);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [createTaskColumnId, setCreateTaskColumnId] = useState<string | null>(null);

  const workspaceId = selectedWorkspaceId ?? workspaces?.[0]?.id ?? null;
  const { data: projects } = useProjects(workspaceId);
  const projectId = selectedProjectId ?? projects?.[0]?.id ?? null;
  const { data: columns } = useProjectColumns(projectId);
  const { data: tasks } = useTasks(projectId);

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-6 py-4 border-b">
        <h1 className="text-xl font-semibold">任务看板</h1>
        <div className="flex items-center gap-3">
          {workspaces && workspaces.length > 0 && (
            <Select value={workspaceId ?? ''} onValueChange={setSelectedWorkspaceId}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="选择团队" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {projects && projects.length > 0 && (
            <Select value={projectId ?? ''} onValueChange={setSelectedProjectId}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="选择项目" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button size="sm" onClick={() => setShowCreateProject(true)}>
            <Plus className="h-4 w-4 mr-1" />
            新建项目
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-hidden p-6">
        {!workspaceId ? (
          <EmptyState message="请先创建一个团队空间" />
        ) : !projectId ? (
          <EmptyState message="请创建项目以开始管理任务" />
        ) : columns && tasks ? (
          <KanbanBoard
            columns={columns}
            tasks={tasks}
            onAddTask={(columnId) => setCreateTaskColumnId(columnId)}
          />
        ) : (
          <div className="text-muted-foreground text-sm">加载中...</div>
        )}
      </div>

      {workspaceId && (
        <CreateProjectDialog
          workspaceId={workspaceId}
          open={showCreateProject}
          onOpenChange={setShowCreateProject}
        />
      )}

      {projectId && workspaceId && createTaskColumnId && (
        <CreateTaskDialog
          projectId={projectId}
          workspaceId={workspaceId}
          columnId={createTaskColumnId}
          open={!!createTaskColumnId}
          onOpenChange={(open) => { if (!open) setCreateTaskColumnId(null); }}
        />
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <div className="text-center space-y-2">
        <div className="text-3xl">📋</div>
        <p>{message}</p>
      </div>
    </div>
  );
}
