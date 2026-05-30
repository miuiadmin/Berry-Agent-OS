import { useState } from 'react';
import { useCreateAgent } from '../../hooks/use-agents';
import type { Agent } from '../../lib/types';

const USER_ID = 'default-user';

const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'custom', label: '自定义' },
];

const THINKING_LEVELS = [
  { value: '', label: '默认' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最高' },
];

const L2_CAPABILITIES = [
  { value: 'learning', label: '学习' },
  { value: 'skills', label: '技能' },
  { value: 'code', label: '代码' },
  { value: 'tools', label: '工具' },
  { value: 'search', label: '搜索' },
  { value: 'memory', label: '记忆' },
  { value: 'decompose', label: '分解' },
  { value: 'review', label: '审核' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  agents: Agent[];
}

export function AgentForm({ open, onClose, workspaceId, agents }: Props) {
  const [name, setName] = useState('');
  const [roleDescription, setRoleDescription] = useState('');
  const [provider, setProvider] = useState('anthropic');
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [superiorId, setSuperiorId] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>(['learning', 'skills']);
  const createAgent = useCreateAgent();

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createAgent.mutate(
      {
        workspaceId,
        userId: USER_ID,
        name,
        roleDescription: roleDescription || undefined,
        provider,
        config: { model: provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o' },
        thinkingLevel: thinkingLevel || undefined,
        superiorId: superiorId || undefined,
        l2Capabilities: capabilities,
      },
      {
        onSuccess: () => {
          setName('');
          setRoleDescription('');
          setProvider('anthropic');
          setThinkingLevel('');
          setSuperiorId('');
          setCapabilities(['learning', 'skills']);
          onClose();
        },
      },
    );
  };

  const toggleCapability = (cap: string) => {
    setCapabilities((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap],
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card border rounded-lg shadow-lg w-full max-w-lg p-6 space-y-4 max-h-[80vh] overflow-y-auto">
        <h2 className="text-lg font-semibold">添加 Agent</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Agent 名称"
              className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">角色描述</label>
            <textarea
              value={roleDescription}
              onChange={(e) => setRoleDescription(e.target.value)}
              placeholder="描述这个 Agent 的职责..."
              rows={2}
              className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">提供商</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">思考深度</label>
              <select
                value={thinkingLevel}
                onChange={(e) => setThinkingLevel(e.target.value)}
                className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {THINKING_LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">上级 Agent</label>
            <select
              value={superiorId}
              onChange={(e) => setSuperiorId(e.target.value)}
              className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">无上级 (顶层)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">L2 能力</label>
            <div className="flex flex-wrap gap-2">
              {L2_CAPABILITIES.map((cap) => (
                <button
                  key={cap.value}
                  type="button"
                  onClick={() => toggleCapability(cap.value)}
                  className={`px-2 py-1 rounded text-xs transition-colors ${
                    capabilities.includes(cap.value)
                      ? 'bg-primary text-primary-foreground'
                      : 'border hover:bg-accent'
                  }`}
                >
                  {cap.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md border text-sm hover:bg-accent transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!name || createAgent.isPending}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {createAgent.isPending ? '创建中...' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
