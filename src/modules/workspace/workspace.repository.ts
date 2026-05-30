import { eq, and } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import { workspaces, workspaceMembers } from '../../db/schema/workspaces.js';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type Workspace = InferSelectModel<typeof workspaces>;
export type NewWorkspace = InferInsertModel<typeof workspaces>;
export type WorkspaceMember = InferSelectModel<typeof workspaceMembers>;
export type NewWorkspaceMember = InferInsertModel<typeof workspaceMembers>;

export class WorkspaceRepository {
  constructor(private db: AppDb) {}

  findById(id: string): Workspace | undefined {
    return this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  }

  findBySlug(slug: string): Workspace | undefined {
    return this.db.select().from(workspaces).where(eq(workspaces.slug, slug)).get();
  }

  findByOwner(ownerId: string): Workspace[] {
    return this.db.select().from(workspaces).where(eq(workspaces.ownerId, ownerId)).all();
  }

  insert(workspace: NewWorkspace): void {
    this.db.insert(workspaces).values(workspace).run();
  }

  update(id: string, data: Partial<Omit<NewWorkspace, 'id'>>): void {
    this.db.update(workspaces).set(data).where(eq(workspaces.id, id)).run();
  }

  delete(id: string): void {
    this.db.delete(workspaces).where(eq(workspaces.id, id)).run();
  }

  findMembers(workspaceId: string): WorkspaceMember[] {
    return this.db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)).all();
  }

  findMember(workspaceId: string, userId: string): WorkspaceMember | undefined {
    return this.db.select().from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .get();
  }

  insertMember(member: NewWorkspaceMember): void {
    this.db.insert(workspaceMembers).values(member).run();
  }

  removeMember(workspaceId: string, userId: string): void {
    this.db.delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .run();
  }

  updateMemberRole(workspaceId: string, userId: string, role: string): void {
    this.db.update(workspaceMembers)
      .set({ role })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .run();
  }
}
