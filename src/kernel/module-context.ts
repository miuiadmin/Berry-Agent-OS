import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import type { EventBus } from './event-bus.js';
import type { ModuleRegistry } from './module-system.js';
import { createModuleLogger } from '../utils/logger.js';

export interface ModuleContext {
  moduleName: string;
  config: AppConfig;
  db: Database.Database;
  eventBus: EventBus;
  registry: ModuleRegistry;
  logger: ReturnType<typeof createModuleLogger>;
}

export interface CreateModuleContextInput {
  moduleName: string;
  config: AppConfig;
  db: Database.Database;
  eventBus: EventBus;
  registry: ModuleRegistry;
}

export function createModuleContext(input: CreateModuleContextInput): ModuleContext {
  return {
    moduleName: input.moduleName,
    config: input.config,
    db: input.db,
    eventBus: input.eventBus,
    registry: input.registry,
    logger: createModuleLogger(input.moduleName),
  };
}
