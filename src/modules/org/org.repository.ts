import { eq, and, like } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import { orgNodes } from '../../db/schema/org-nodes.js';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type OrgNode = InferSelectModel<typeof orgNodes>;
export type NewOrgNode = InferInsertModel<typeof orgNodes>;

export class OrgRepository {
  constructor(private db: AppDb) {}

  findById(id: string): OrgNode | undefined {
    return this.db.select().from(orgNodes).where(eq(orgNodes.id, id)).get();
  }

  findByWorkspace(workspaceId: string): OrgNode[] {
    return this.db.select().from(orgNodes).where(eq(orgNodes.workspaceId, workspaceId)).all();
  }

  findChildren(parentId: string): OrgNode[] {
    return this.db.select().from(orgNodes).where(eq(orgNodes.parentId, parentId)).all();
  }

  findByPath(workspaceId: string, pathPrefix: string): OrgNode[] {
    return this.db.select().from(orgNodes)
      .where(and(eq(orgNodes.workspaceId, workspaceId), like(orgNodes.path, `${pathPrefix}%`)))
      .all();
  }

  findRoots(workspaceId: string): OrgNode[] {
    return this.db.select().from(orgNodes)
      .where(and(eq(orgNodes.workspaceId, workspaceId), eq(orgNodes.depth, 0)))
      .all();
  }

  insert(node: NewOrgNode): void {
    this.db.insert(orgNodes).values(node).run();
  }

  update(id: string, data: Partial<Omit<NewOrgNode, 'id'>>): void {
    this.db.update(orgNodes).set(data).where(eq(orgNodes.id, id)).run();
  }

  delete(id: string): void {
    this.db.delete(orgNodes).where(eq(orgNodes.id, id)).run();
  }

  deleteSubtree(workspaceId: string, pathPrefix: string): void {
    this.db.delete(orgNodes)
      .where(and(eq(orgNodes.workspaceId, workspaceId), like(orgNodes.path, `${pathPrefix}%`)))
      .run();
  }
}
