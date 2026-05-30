import type { Agent } from '../../lib/types';

const STATUS_COLORS: Record<string, string> = {
  idle: 'bg-green-500',
  busy: 'bg-yellow-500',
  offline: 'bg-gray-400',
  error: 'bg-red-500',
};

const TRUST_LABELS: Record<string, { label: string; color: string }> = {
  probation: { label: '试用', color: 'bg-orange-100 text-orange-700' },
  standard: { label: '标准', color: 'bg-blue-100 text-blue-700' },
  trusted: { label: '信任', color: 'bg-green-100 text-green-700' },
  autonomous: { label: '自主', color: 'bg-purple-100 text-purple-700' },
};

interface Props {
  agent: Agent;
  onClick?: () => void;
  onChat?: () => void;
}

export function AgentCard({ agent, onClick, onChat }: Props) {
  const trust = TRUST_LABELS[agent.trustLevel] || TRUST_LABELS.probation;

  return (
    <div
      className="text-left border rounded-lg p-4 space-y-3 hover:border-primary/50 hover:bg-accent/30 transition-colors w-full"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 cursor-pointer" onClick={onClick}>
          <div className={`w-2 h-2 rounded-full ${STATUS_COLORS[agent.status] || STATUS_COLORS.offline}`} />
          <h3 className="font-medium text-sm truncate">{agent.name}</h3>
        </div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${trust.color}`}>
          {trust.label}
        </span>
      </div>

      {agent.roleDescription && (
        <p className="text-xs text-muted-foreground line-clamp-2">{agent.roleDescription}</p>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>{agent.provider}</span>
          {agent.thinkingLevel && <span>思考: {agent.thinkingLevel}</span>}
          {agent.totalExecutions > 0 && <span>执行: {agent.totalExecutions}</span>}
        </div>
        {onChat && (
          <button
            onClick={(e) => { e.stopPropagation(); onChat(); }}
            className="text-xs px-2 py-1 rounded-md border hover:bg-accent transition-colors"
          >
            对话
          </button>
        )}
      </div>
    </div>
  );
}
