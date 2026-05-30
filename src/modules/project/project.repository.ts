import { eq, and } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import { projects, taskColumns } from '../../db/schema/projects.js';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type Project = InferSelectModel<typeof projects>;
export type NewProject = InferInsertModel<typeof projects>;
export type TaskColumn = InferSelectModel<typeof taskColumns>;
export type NewTaskColumn = InferInsertModel<typeof taskColumns>;

export class ProjectRepository {
  constructor(private db: AppDb) {}

  findById(id: string): Project | undefined {
    return this.db.select().from(projects).where(eq(projects.id, id)).get();
  }

  findByWorkspace(workspaceId: string): Project[] {
    return this.db.select().from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.status, 'active')))
      .all();
  }

  insert(project: NewProject): void {
    this.db.insert(projects).values(project).run();
  }

  update(id: string, data: Partial<Omit<NewProject, 'id'>>): void {
    this.db.update(projects).set(data).where(eq(projects.id, id)).run();
  }

  delete(id: string): void {
    this.db.delete(projects).where(eq(projects.id, id)).run();
  }

  findColumns(projectId: string): TaskColumn[] {
    return this.db.select().from(taskColumns).where(eq(taskColumns.projectId, projectId)).all();
  }

  insertColumn(column: NewTaskColumn): void {
    this.db.insert(taskColumns).values(column).run();
  }

  updateColumn(id: string, data: Partial<Omit<NewTaskColumn, 'id'>>): void {
    this.db.update(taskColumns).set(data).where(eq(taskColumns.id, id)).run();
  }

  deleteColumn(id: string): void {
    this.db.delete(taskColumns).where(eq(taskColumns.id, id)).run();
  }
}
