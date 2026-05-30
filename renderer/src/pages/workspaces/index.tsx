import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaces } from '../../hooks/use-workspaces';
import { CreateWorkspaceDialog } from '../../components/workspace/CreateWorkspaceDialog';
import type { Workspace } from '../../lib/types';

const USER_ID = 'default-user';

export function WorkspacesPage() {
  const [showCreate, setShowCreate] = useState(false);
  const { data: workspaces, isLoading } = useWorkspaces(USER_ID);
  const navigate = useNavigate();

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">工作空间</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          创建团队
        </button>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground text-sm">加载中...</div>
      ) : !workspaces?.length ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <div className="text-4xl mb-4">🏢</div>
          <p className="text-lg">还没有工作空间</p>
          <p className="text-sm mt-1">创建一个团队开始协作</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {workspaces.map((ws: Workspace) => (
            <WorkspaceCard key={ws.id} workspace={ws} onClick={() => navigate(`/workspaces/${ws.id}`)} />
          ))}
        </div>
      )}

      <CreateWorkspaceDialog open={showCreate} onClose={() => setShowCreate(false)} userId={USER_ID} />
    </div>
  );
}

function WorkspaceCard({ workspace, onClick }: { workspace: Workspace; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left border rounded-lg p-4 space-y-2 hover:border-primary/50 hover:bg-accent/30 transition-colors"
    >
      <h3 className="font-medium truncate">{workspace.name}</h3>
      {workspace.description && (
        <p className="text-sm text-muted-foreground line-clamp-2">{workspace.description}</p>
      )}
      <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1">
        <span>审核模式: {workspace.reviewMode === 'strict' ? '严格' : '信任'}</span>
      </div>
    </button>
  );
}
