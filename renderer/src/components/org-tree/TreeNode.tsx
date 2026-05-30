import { useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { OrgNode } from '../../lib/types';

interface Props {
  node: OrgNode;
  childrenMap: Map<string, OrgNode[]>;
  depth: number;
  addingTo: string | null;
  newNodeName: string;
  onSetAddingTo: (id: string | null) => void;
  onSetNewNodeName: (name: string) => void;
  onAddNode: (parentId: string) => void;
  onDeleteNode: (nodeId: string) => void;
}

const TYPE_LABELS: Record<string, string> = {
  root: '根',
  group: '组',
  department: '部门',
  system: '系统',
  center: '中心',
  custom: '自定义',
};

export function TreeNode({ node, childrenMap, depth, addingTo, newNodeName, onSetAddingTo, onSetNewNodeName, onAddNode, onDeleteNode }: Props) {
  const [expanded, setExpanded] = useState(true);
  const children = childrenMap.get(node.id) || [];

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: node.id });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: node.id });

  return (
    <div>
      <div
        ref={(el) => { setDragRef(el); setDropRef(el); }}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        className={`flex items-center gap-2 py-1.5 pr-2 rounded-md group transition-colors ${
          isDragging ? 'opacity-40' : ''
        } ${isOver ? 'bg-primary/10 ring-1 ring-primary/30' : 'hover:bg-accent/50'}`}
        {...attributes}
        {...listeners}
      >
        {children.length > 0 ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-4 h-4 flex items-center justify-center text-muted-foreground text-xs"
          >
            {expanded ? '▼' : '▶'}
          </button>
        ) : (
          <span className="w-4 h-4 flex items-center justify-center text-muted-foreground text-xs">·</span>
        )}

        <span className="text-sm flex-1 truncate">{node.name}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
          {TYPE_LABELS[node.type] || node.type}
        </span>

        <div className="hidden group-hover:flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); onSetAddingTo(node.id); }}
            className="text-xs px-1.5 py-0.5 rounded hover:bg-accent text-muted-foreground"
            title="添加子节点"
          >
            +
          </button>
          {node.type !== 'root' && (
            <button
              onClick={(e) => { e.stopPropagation(); onDeleteNode(node.id); }}
              className="text-xs px-1.5 py-0.5 rounded hover:bg-destructive/10 text-destructive"
              title="删除"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {addingTo === node.id && (
        <div style={{ paddingLeft: `${(depth + 1) * 20 + 8}px` }} className="flex items-center gap-2 py-1">
          <input
            type="text"
            value={newNodeName}
            onChange={(e) => onSetNewNodeName(e.target.value)}
            placeholder="节点名称"
            className="px-2 py-1 text-sm border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') onAddNode(node.id);
              if (e.key === 'Escape') onSetAddingTo(null);
            }}
          />
          <button
            onClick={() => onAddNode(node.id)}
            className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground"
          >
            确认
          </button>
          <button
            onClick={() => onSetAddingTo(null)}
            className="text-xs px-2 py-1 rounded border hover:bg-accent"
          >
            取消
          </button>
        </div>
      )}

      {expanded && children.length > 0 && (
        <div>
          {children
            .sort((a, b) => a.position - b.position)
            .map((child) => (
              <TreeNode
                key={child.id}
                node={child}
                childrenMap={childrenMap}
                depth={depth + 1}
                addingTo={addingTo}
                newNodeName={newNodeName}
                onSetAddingTo={onSetAddingTo}
                onSetNewNodeName={onSetNewNodeName}
                onAddNode={onAddNode}
                onDeleteNode={onDeleteNode}
              />
            ))}
        </div>
      )}
    </div>
  );
}
