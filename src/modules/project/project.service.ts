import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import { ProjectRepository } from './project.repository.js';
import type { Project, TaskColumn } from './project.repository.js';

export interface CreateProjectInput {
  workspaceId: string;
  orgNodeId?: string;
  name: string;
  description?: string;
  visibility?: 'private' | 'public';
  defaultColumns?: string[];
}

const DEFAULT_COLUMNS = ['待办', '进行中', '审核中', '已完成'];

export class ProjectService {
  constructor(
    private repo: ProjectRepository,
    private events: AppEvents,
  ) {}

  create(input: CreateProjectInput): Project {
    const id = genId();
    const now = new Date();
    const project = {
      id,
      workspaceId: input.workspaceId,
      orgNodeId: input.orgNodeId ?? null,
      name: input.name,
      description: input.description ?? null,
      status: 'active',
      visibility: input.visibility ?? 'private',
      defaultColumns: null,
      createdAt: now,
    };
    this.repo.insert(project);

    const columns = input.defaultColumns ?? DEFAULT_COLUMNS;
    for (let i = 0; i < columns.length; i++) {
      this.repo.insertColumn({
        id: genId(),
        projectId: id,
        name: columns[i],
        position: i,
        color: null,
        wipLimit: null,
      });
    }

    this.events.emit('project.created', { projectId: id, workspaceId: input.workspaceId });
    return project as Project;
  }

  getById(id: string): Project | undefined {
    return this.repo.findById(id);
  }

  listByWorkspace(workspaceId: string): Project[] {
    return this.repo.findByWorkspace(workspaceId);
  }

  update(id: string, data: Partial<Pick<Project, 'name' | 'description' | 'visibility'>>): void {
    this.repo.update(id, data);
    this.events.emit('project.updated', { projectId: id });
  }

  archive(id: string): void {
    this.repo.update(id, { status: 'archived' });
    this.events.emit('project.archived', { projectId: id });
  }

  getColumns(projectId: string): TaskColumn[] {
    return this.repo.findColumns(projectId);
  }

  addColumn(projectId: string, name: string, color?: string): TaskColumn {
    const existing = this.repo.findColumns(projectId);
    const col = {
      id: genId(),
      projectId,
      name,
      position: existing.length,
      color: color ?? null,
      wipLimit: null,
    };
    this.repo.insertColumn(col);
    return col as TaskColumn;
  }

  updateColumn(columnId: string, data: Partial<Pick<TaskColumn, 'name' | 'color' | 'wipLimit' | 'position'>>): void {
    this.repo.updateColumn(columnId, data);
  }

  deleteColumn(columnId: string): void {
    this.repo.deleteColumn(columnId);
  }
}
