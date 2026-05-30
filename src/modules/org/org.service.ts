import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import { OrgRepository } from './org.repository.js';
import type { OrgNode } from './org.repository.js';

export interface CreateOrgNodeInput {
  workspaceId: string;
  parentId?: string;
  name: string;
  description?: string;
  type: 'root' | 'group' | 'department' | 'system' | 'center' | 'custom';
  metadata?: unknown;
}

export interface MoveNodeInput {
  nodeId: string;
  newParentId: string | null;
}

export class OrgService {
  constructor(
    private repo: OrgRepository,
    private events: AppEvents,
  ) {}

  create(input: CreateOrgNodeInput): OrgNode {
    const id = genId();
    const now = new Date();

    let path: string;
    let depth: number;
    let position: number;

    if (input.parentId) {
      const parent = this.repo.findById(input.parentId);
      if (!parent) throw new Error(`Parent node not found: ${input.parentId}`);
      path = `${parent.path}/${id}`;
      depth = parent.depth + 1;
      const siblings = this.repo.findChildren(input.parentId);
      position = siblings.length;
    } else {
      path = `/${id}`;
      depth = 0;
      const roots = this.repo.findRoots(input.workspaceId);
      position = roots.length;
    }

    const node: OrgNode = {
      id,
      workspaceId: input.workspaceId,
      parentId: input.parentId ?? null,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      path,
      depth,
      position,
      metadata: (input.metadata ?? null) as any,
      createdAt: now,
    };

    this.repo.insert(node);
    this.events.emit('org.node.created', {
      workspaceId: input.workspaceId,
      nodeId: id,
      parentId: input.parentId ?? null,
    });
    return node;
  }

  getById(id: string): OrgNode | undefined {
    return this.repo.findById(id);
  }

  getTree(workspaceId: string): OrgNode[] {
    return this.repo.findByWorkspace(workspaceId);
  }

  getChildren(parentId: string): OrgNode[] {
    return this.repo.findChildren(parentId);
  }

  getSubtree(workspaceId: string, nodeId: string): OrgNode[] {
    const node = this.repo.findById(nodeId);
    if (!node) return [];
    return this.repo.findByPath(workspaceId, node.path);
  }

  move(input: MoveNodeInput): void {
    const node = this.repo.findById(input.nodeId);
    if (!node) throw new Error(`Node not found: ${input.nodeId}`);

    const oldParentId = node.parentId;
    let newPath: string;
    let newDepth: number;

    if (input.newParentId) {
      const newParent = this.repo.findById(input.newParentId);
      if (!newParent) throw new Error(`New parent not found: ${input.newParentId}`);
      newPath = `${newParent.path}/${node.id}`;
      newDepth = newParent.depth + 1;
    } else {
      newPath = `/${node.id}`;
      newDepth = 0;
    }

    const oldPath = node.path;
    const descendants = this.repo.findByPath(node.workspaceId, `${oldPath}/`);

    this.repo.update(node.id, {
      parentId: input.newParentId ?? null,
      path: newPath,
      depth: newDepth,
    });

    for (const desc of descendants) {
      const updatedPath = desc.path.replace(oldPath, newPath);
      const depthDiff = newDepth - node.depth;
      this.repo.update(desc.id, {
        path: updatedPath,
        depth: desc.depth + depthDiff,
      });
    }

    this.events.emit('org.node.moved', {
      workspaceId: node.workspaceId,
      nodeId: node.id,
      oldParentId,
      newParentId: input.newParentId,
    });
  }

  delete(nodeId: string): void {
    const node = this.repo.findById(nodeId);
    if (!node) return;
    this.repo.deleteSubtree(node.workspaceId, node.path);
    this.events.emit('org.node.deleted', { workspaceId: node.workspaceId, nodeId });
  }
}
