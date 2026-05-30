import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgents } from '../../hooks/use-agents';
import { AgentCard } from './AgentCard';
import { AgentForm } from './AgentForm';
import type { Agent } from '../../lib/types';

interface Props {
  workspaceId: string;
}

export function AgentList({ workspaceId }: Props) {
  const { data: agents, isLoading } = useAgents(workspaceId);
  const [showForm, setShowForm] = useState(false);
  const navigate = useNavigate();

  if (isLoading) {
    return <div className="text-muted-foreground text-sm">加载 Agent...</div>;
  }

  const activeAgents = (agents || []).filter((a: Agent) => !a.archivedAt);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {activeAgents.length} 个 Agent
        </h2>
        <button
          onClick={() => setShowForm(true)}
          className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors"
        >
          添加 Agent
        </button>
      </div>

      {!activeAgents.length ? (
        <div className="text-center py-10 text-muted-foreground text-sm">
          暂无 Agent
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {activeAgents.map((agent: Agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onChat={() => navigate(`/workspaces/${workspaceId}/chat/${agent.id}`)}
            />
          ))}
        </div>
      )}

      <AgentForm
        open={showForm}
        onClose={() => setShowForm(false)}
        workspaceId={workspaceId}
        agents={activeAgents}
      />
    </div>
  );
}
