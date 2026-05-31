import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import { TaskRepository } from './task.repository.js';
import type { Task } from './task.repository.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';

export interface CreateTaskInput {
  projectId: string;
  workspaceId: string;
  columnId: string;
  parentTaskId?: string;
  title: string;
  description?: string;
  assigneeType?: 'agent' | 'user' | 'role';
  assigneeId?: string;
  creatorType: 'agent' | 'user' | 'system';
  creatorId: string;
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  estimatedHours?: number;
  dueDate?: Date;
  acceptanceCriteria?: Array<{ text: string; checked: boolean }>;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  columnId?: string;
  assigneeType?: string;
  assigneeId?: string;
  priority?: string;
  position?: number;
  estimatedHours?: number;
  actualHours?: number;
  dueDate?: Date | null;
  startDate?: Date | null;
  acceptanceCriteria?: Array<{ text: string; checked: boolean }>;
  metadata?: Record<string, unknown>;
}

export class TaskService {
  constructor(
    private repo: TaskRepository,
    private workspaceService: WorkspaceService,
    private events: AppEvents,
  ) {}

  create(input: CreateTaskInput): Task {
    const id = genId();
    const now = new Date();
    const number = this.workspaceService.nextIssueNumber(input.workspaceId);

    const ws = this.workspaceService.getById(input.workspaceId);
    const prefix = ws?.issuePrefix ?? 'TASK';
    const identifier = `${prefix}-${number}`;

    const task = {
      id,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      columnId: input.columnId,
      parentTaskId: input.parentTaskId ?? null,
      number,
      identifier,
      title: input.title,
      description: input.description ?? null,
      assigneeType: input.assigneeType ?? null,
      assigneeId: input.assigneeId ?? null,
      creatorType: input.creatorType,
      creatorId: input.creatorId,
      priority: input.priority ?? 'medium',
      position: 0,
      estimatedHours: input.estimatedHours ?? null,
      actualHours: null,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      metadata: input.metadata ?? null,
      startDate: null,
      dueDate: input.dueDate ?? null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
    };

    this.repo.insert(task);

    this.repo.insertSubscriber({
      id: genId(),
      taskId: id,
      subscriberType: input.creatorType,
      subscriberId: input.creatorId,
      reason: 'creator',
      createdAt: now,
    });

    if (input.assigneeId) {
      this.repo.insertSubscriber({
        id: genId(),
        taskId: id,
        subscriberType: input.assigneeType!,
        subscriberId: input.assigneeId,
        reason: 'assignee',
        createdAt: now,
      });
    }

    this.events.emit('task.created', {
      taskId: id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    });

    return task as Task;
  }

  getById(id: string): Task | undefined {
    return this.repo.findById(id);
  }

  listByProject(projectId: string): Task[] {
    return this.repo.findByProject(projectId);
  }

  listByColumn(columnId: string): Task[] {
    return this.repo.findByColumn(columnId);
  }

  listByAssignee(assigneeType: string, assigneeId: string): Task[] {
    return this.repo.findByAssignee(assigneeType, assigneeId);
  }

  getSubtasks(taskId: string): Task[] {
    return this.repo.findSubtasks(taskId);
  }

  update(id: string, input: UpdateTaskInput): void {
    const task = this.repo.findById(id);
    if (!task) return;

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.position !== undefined) data.position = input.position;
    if (input.estimatedHours !== undefined) data.estimatedHours = input.estimatedHours;
    if (input.actualHours !== undefined) data.actualHours = input.actualHours;
    if (input.dueDate !== undefined) data.dueDate = input.dueDate;
    if (input.startDate !== undefined) data.startDate = input.startDate;
    if (input.acceptanceCriteria !== undefined) data.acceptanceCriteria = input.acceptanceCriteria;
    if (input.metadata !== undefined) data.metadata = input.metadata;

    if (input.columnId !== undefined && input.columnId !== task.columnId) {
      data.columnId = input.columnId;
      this.repo.update(id, data);
      this.events.emit('task.moved', { taskId: id, fromColumnId: task.columnId, toColumnId: input.columnId });
    } else {
      this.repo.update(id, data);
    }

    if (input.assigneeType !== undefined && input.assigneeId !== undefined) {
      this.repo.update(id, { assigneeType: input.assigneeType, assigneeId: input.assigneeId });
      this.events.emit('task.assigned', {
        taskId: id,
        assigneeType: input.assigneeType,
        assigneeId: input.assigneeId,
      });
    }

    this.events.emit('task.updated', { taskId: id });
  }

  complete(id: string): void {
    this.repo.update(id, { completedAt: new Date() });
    const task = this.repo.findById(id);
    if (task) {
      this.events.emit('task.completed', { taskId: id, workspaceId: task.workspaceId });
    }
  }

  delete(id: string): void {
    this.repo.delete(id);
    this.events.emit('task.deleted', { taskId: id });
  }

  addDependency(blockingTaskId: string, blockedTaskId: string, creatorType: string, creatorId: string): void {
    this.repo.insertDependency({
      id: genId(),
      blockingTaskId,
      blockedTaskId,
      dependencyType: 'finish_to_start',
      createdByType: creatorType,
      createdById: creatorId,
      createdAt: new Date(),
    });
  }
}
