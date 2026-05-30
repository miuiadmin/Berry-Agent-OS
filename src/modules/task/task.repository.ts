import { eq, and } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import { tasks, taskLabels, taskLabelLinks, taskDependencies, taskSubscribers } from '../../db/schema/tasks.js';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type Task = InferSelectModel<typeof tasks>;
export type NewTask = InferInsertModel<typeof tasks>;
export type TaskLabel = InferSelectModel<typeof taskLabels>;
export type TaskDependency = InferSelectModel<typeof taskDependencies>;
export type TaskSubscriber = InferSelectModel<typeof taskSubscribers>;

export class TaskRepository {
  constructor(private db: AppDb) {}

  findById(id: string): Task | undefined {
    return this.db.select().from(tasks).where(eq(tasks.id, id)).get();
  }

  findByProject(projectId: string): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();
  }

  findByWorkspace(workspaceId: string): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.workspaceId, workspaceId)).all();
  }

  findByColumn(columnId: string): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.columnId, columnId)).all();
  }

  findByAssignee(assigneeType: string, assigneeId: string): Task[] {
    return this.db.select().from(tasks)
      .where(and(eq(tasks.assigneeType, assigneeType), eq(tasks.assigneeId, assigneeId)))
      .all();
  }

  findSubtasks(parentTaskId: string): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.parentTaskId, parentTaskId)).all();
  }

  insert(task: NewTask): void {
    this.db.insert(tasks).values(task).run();
  }

  update(id: string, data: Partial<Omit<NewTask, 'id'>>): void {
    this.db.update(tasks).set(data).where(eq(tasks.id, id)).run();
  }

  delete(id: string): void {
    this.db.delete(tasks).where(eq(tasks.id, id)).run();
  }

  // Labels
  findLabels(workspaceId: string): TaskLabel[] {
    return this.db.select().from(taskLabels).where(eq(taskLabels.workspaceId, workspaceId)).all();
  }

  insertLabel(label: InferInsertModel<typeof taskLabels>): void {
    this.db.insert(taskLabels).values(label).run();
  }

  findTaskLabels(taskId: string): TaskLabel[] {
    const links = this.db.select().from(taskLabelLinks).where(eq(taskLabelLinks.taskId, taskId)).all();
    if (links.length === 0) return [];
    return links.map(link => this.db.select().from(taskLabels).where(eq(taskLabels.id, link.labelId)).get()!).filter(Boolean);
  }

  addLabelToTask(taskId: string, labelId: string): void {
    this.db.insert(taskLabelLinks).values({ taskId, labelId }).run();
  }

  removeLabelFromTask(taskId: string, labelId: string): void {
    this.db.delete(taskLabelLinks)
      .where(and(eq(taskLabelLinks.taskId, taskId), eq(taskLabelLinks.labelId, labelId)))
      .run();
  }

  // Dependencies
  findDependencies(taskId: string): TaskDependency[] {
    return this.db.select().from(taskDependencies).where(eq(taskDependencies.blockedTaskId, taskId)).all();
  }

  findBlocking(taskId: string): TaskDependency[] {
    return this.db.select().from(taskDependencies).where(eq(taskDependencies.blockingTaskId, taskId)).all();
  }

  insertDependency(dep: InferInsertModel<typeof taskDependencies>): void {
    this.db.insert(taskDependencies).values(dep).run();
  }

  // Subscribers
  findSubscribers(taskId: string): TaskSubscriber[] {
    return this.db.select().from(taskSubscribers).where(eq(taskSubscribers.taskId, taskId)).all();
  }

  insertSubscriber(sub: InferInsertModel<typeof taskSubscribers>): void {
    this.db.insert(taskSubscribers).values(sub).run();
  }
}
