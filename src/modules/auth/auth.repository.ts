import { eq } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import { users } from '../../db/schema/users.js';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export class AuthRepository {
  constructor(private db: AppDb) {}

  findById(id: string): User | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  findByEmail(email: string): User | undefined {
    return this.db.select().from(users).where(eq(users.email, email)).get();
  }

  insert(user: NewUser): void {
    this.db.insert(users).values(user).run();
  }

  update(id: string, data: Partial<Omit<NewUser, 'id'>>): void {
    this.db.update(users).set(data).where(eq(users.id, id)).run();
  }

  delete(id: string): void {
    this.db.delete(users).where(eq(users.id, id)).run();
  }
}
