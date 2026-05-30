import { useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useOrgTree, useCreateNode, useMoveNode, useDeleteNode } from '../../hooks/use-org-tree';
import { TreeNode } from './TreeNode';
import type { OrgNode } from '../../lib/types';

interface Props {
  workspaceId: string;
}

export function TreeView({ workspaceId }: Props) {
  const { data: nodes, isLoading } = useOrgTree(workspaceId);
  const createNode = useCreateNode();
  const moveNode = useMoveNode();
  const deleteNode = useDeleteNode();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newNodeName, setNewNodeName] = useState('');

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  if (isLoading) {
    return <div className="text-muted-foreground text-sm">加载组织树...</div>;
  }

  if (!nodes?.length) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        <p>暂无组织节点</p>
      </div>
    );
  }

  const rootNodes = nodes.filter((n: OrgNode) => !n.parentId);
  const childrenMap = new Map<string, OrgNode[]>();
  for (const node of nodes) {
    if (node.parentId) {
      const list = childrenMap.get(node.parentId) || [];
      list.push(node);
      childrenMap.set(node.parentId, list);
    }
  }

  const handleDragStart = (event: DragStartEvent) => {
    setDraggingId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeNode = nodes.find((n: OrgNode) => n.id === active.id);
    if (!activeNode) return;

    moveNode.mutate({ nodeId: active.id as string, newParentId: over.id as string, workspaceId });
  };

  const handleAddNode = (parentId: string) => {
    if (!newNodeName.trim()) return;
    createNode.mutate(
      { workspaceId, parentId, name: newNodeName.trim(), type: 'group' },
      { onSuccess: () => { setNewNodeName(''); setAddingTo(null); } },
    );
  };

  const handleDeleteNode = (nodeId: string) => {
    deleteNode.mutate({ nodeId, workspaceId });
  };

  const draggingNode = draggingId ? nodes.find((n: OrgNode) => n.id === draggingId) : null;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="space-y-1">
        {rootNodes.map((node: OrgNode) => (
          <TreeNode
            key={node.id}
            node={node}
            childrenMap={childrenMap}
            depth={0}
            addingTo={addingTo}
            newNodeName={newNodeName}
            onSetAddingTo={setAddingTo}
            onSetNewNodeName={setNewNodeName}
            onAddNode={handleAddNode}
            onDeleteNode={handleDeleteNode}
          />
        ))}
      </div>
      <DragOverlay>
        {draggingNode && (
          <div className="px-3 py-1.5 bg-card border rounded-md shadow-md text-sm">
            {draggingNode.name}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
