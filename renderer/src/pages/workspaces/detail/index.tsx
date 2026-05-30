import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWorkspace } from '../../../hooks/use-workspaces';
import { TreeView } from '../../../components/org-tree/TreeView';
import { AgentList } from '../../../components/agent/AgentList';

type Tab = 'org' | 'agents';

export function WorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: workspace, isLoading } = useWorkspace(id!);
  const [activeTab, setActiveTab] = useState<Tab>('org');

  if (isLoading) {
    return <div className="p-6 text-muted-foreground text-sm">加载中...</div>;
  }

  if (!workspace) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">工作空间不存在</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-6 py-4 space-y-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/workspaces')}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            ←
          </button>
          <div>
            <h1 className="text-xl font-semibold">{workspace.name}</h1>
            {workspace.description && (
              <p className="text-sm text-muted-foreground">{workspace.description}</p>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          <TabButton active={activeTab === 'org'} onClick={() => setActiveTab('org')}>
            组织架构
          </TabButton>
          <TabButton active={activeTab === 'agents'} onClick={() => setActiveTab('agents')}>
            Agent 列表
          </TabButton>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {activeTab === 'org' && <TreeView workspaceId={id!} />}
        {activeTab === 'agents' && <AgentList workspaceId={id!} />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
      }`}
    >
      {children}
    </button>
  );
}
