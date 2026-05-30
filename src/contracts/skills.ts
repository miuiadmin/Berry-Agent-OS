import { z } from 'zod';

// === Skill metadata enums ===

export const SkillOriginSchema = z.enum(['bundled', 'generated', 'user']);
export const SkillStateSchema = z.enum(['active', 'stale', 'archived']);
export const SkillCreatedBySchema = z.enum(['system', 'agent', 'user']);

export type SkillOrigin = z.infer<typeof SkillOriginSchema>;
export type SkillState = z.infer<typeof SkillStateSchema>;
export type SkillCreatedBy = z.infer<typeof SkillCreatedBySchema>;

// === Skill visibility ===

export type SkillVisibility = 'on' | 'name-only' | 'user-invocable-only' | 'off';

// === Skill manifest (registry record) ===

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  origin: SkillOrigin;
  filePath: string;
  disabled: boolean;
  createdBy: SkillCreatedBy;
  state: SkillState;
  arguments?: string[];
  whenToUse?: string;
  allowedTools?: string[];
  modelInvocable: boolean;
  descriptionHidden: boolean;
}

// === Structured skill view (get_skill response) ===

export interface SkillView {
  name: string;
  description: string;
  version: string;
  origin: SkillOrigin;
  state: SkillState;
  content: string;
  skillDir: string;
  linkedFiles: SkillLinkedFiles;
  stats: SkillStats;
  arguments?: string[];
  whenToUse?: string;
  note?: string;
}

export interface SkillLinkedFiles {
  references: string[];
  templates: string[];
  scripts: string[];
}

export interface SkillStats {
  viewCount: number;
  useCount: number;
  successRate: number | null;
  patchCount: number;
  lastUsedAt: number | null;
}

// === Skill mutation result ===

export interface SkillMutationResult {
  ok: boolean;
  name: string;
  filePath: string;
  message: string;
}

// === Skill outcome report (report_skill_outcome input) ===

export const SkillOutcomeSchema = z.object({
  name: z.string().describe('刚使用的技能名称'),
  success: z.boolean().describe('技能执行是否成功达到预期目的'),
  note: z.string().optional().describe('可选的简短说明（失败原因或改进建议）'),
});
export type SkillOutcome = z.infer<typeof SkillOutcomeSchema>;

// === Skill patch input (patch_skill input) ===

export const SkillPatchSchema = z.object({
  name: z.string().describe('技能名称'),
  find: z.string().describe('要替换的原文本'),
  replace: z.string().describe('替换后的新文本'),
  replaceAll: z.boolean().optional().describe('是否替换所有匹配项，默认只替换第一处'),
});
export type SkillPatch = z.infer<typeof SkillPatchSchema>;

// === Skill draft input (create_skill input) ===

export interface SkillDraftInput {
  name: string;
  description: string;
  evidence: string[];
  source: 'conversation' | 'manual' | 'reference_source';
}

// === Skill validation result ===

export interface SkillValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// === DB row types (internal telemetry) ===

export interface SkillStatsRow {
  use_count: number;
  view_count: number;
  success_count: number;
  failure_count: number;
  patch_count: number;
  last_used_at: number | null;
}

// === IPC event ===

export const SKILL_CHANGED_EVENT = 'skill.changed' as const;

// === Activation context (Layer 4) ===

export interface SkillActivationContext {
  platform: NodeJS.Platform;
  availableToolsets: Set<string>;
  currentFilePaths: string[];
  environmentVars: Set<string>;
}

// === Permission scope (Layer 4) ===

export interface SkillPermissionScopeContract {
  skillName: string;
  allowedTools?: string[];
  deniedTools?: string[];
  timeout?: number;
  effort?: 'low' | 'medium' | 'high';
}

// === Execute result (Layer 5) ===

export interface SkillExecuteResultContract {
  content: string;
  permissionScope?: SkillPermissionScopeContract;
  hooks: { before: boolean; after: boolean; onError: boolean };
  effort?: 'low' | 'medium' | 'high';
  contextFork: boolean;
}
