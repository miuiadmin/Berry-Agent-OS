import { createHash } from 'node:crypto';
import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import { AuthRepository } from './auth.repository.js';
import type { User } from './auth.repository.js';

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  avatar?: string;
}

export interface UpdateUserInput {
  name?: string;
  avatar?: string;
}

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

export class AuthService {
  constructor(
    private repo: AuthRepository,
    private events: AppEvents,
  ) {}

  create(input: CreateUserInput): User {
    const id = genId();
    const now = new Date();
    const user = {
      id,
      email: input.email,
      name: input.name,
      passwordHash: hashPassword(input.password),
      avatar: input.avatar ?? null,
      createdAt: now,
    };
    this.repo.insert(user);
    this.events.emit('user.created', { userId: id });
    return user;
  }

  getById(id: string): User | undefined {
    return this.repo.findById(id);
  }

  getByEmail(email: string): User | undefined {
    return this.repo.findByEmail(email);
  }

  verifyPassword(email: string, password: string): User | null {
    const user = this.repo.findByEmail(email);
    if (!user) return null;
    if (user.passwordHash !== hashPassword(password)) return null;
    return user;
  }

  update(id: string, input: UpdateUserInput): void {
    this.repo.update(id, input);
    this.events.emit('user.updated', { userId: id });
  }
}
