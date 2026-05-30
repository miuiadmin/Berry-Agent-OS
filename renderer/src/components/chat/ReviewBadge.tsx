import { useState } from 'react';

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending: { label: '审核中', color: 'bg-yellow-100 text-yellow-700' },
  approved: { label: '已通过', color: 'bg-green-100 text-green-700' },
  rejected: { label: '已拒绝', color: 'bg-red-100 text-red-700' },
  modified: { label: '已修改', color: 'bg-blue-100 text-blue-700' },
  reassigned: { label: '已转交', color: 'bg-purple-100 text-purple-700' },
  supplemented: { label: '已补充', color: 'bg-cyan-100 text-cyan-700' },
  suspended: { label: '已暂停', color: 'bg-gray-100 text-gray-700' },
};

interface Props {
  status: string;
  note?: string;
}

export function ReviewBadge({ status, note }: Props) {
  const [expanded, setExpanded] = useState(false);
  const config = STATUS_CONFIG[status];
  if (!config) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => note && setExpanded(!expanded)}
        className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium ${config.color}`}
      >
        {config.label}
        {note && <span className="text-[8px]">{expanded ? '▲' : '▼'}</span>}
      </button>
      {expanded && note && (
        <p className="text-xs text-muted-foreground mt-1 pl-1 border-l-2 border-muted">
          {note}
        </p>
      )}
    </div>
  );
}
