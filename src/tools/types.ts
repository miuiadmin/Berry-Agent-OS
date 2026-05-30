import { z } from 'zod';
import type { ModelToolDef } from '../contracts/model.js';
import type { DangerLevel } from '../utils/types.js';

export type { DangerLevel } from '../utils/types.js';

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  dangerLevel: DangerLevel;
  execute: (input: unknown) => Promise<ToolResult>;
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

export function toModelTools(defs: ToolDefinition[]): ModelToolDef[] {
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: zodToJsonSchema(def.inputSchema),
  }));
}
