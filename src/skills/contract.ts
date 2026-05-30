import type { SkillManifest, SkillDraftInput } from './types.js';
import type { LoadedSkill } from './loader/loader.js';
import type { SkillExecuteArgs, SkillExecuteResult } from './execution/executor.js';
import type { PromptBuildOptions } from './prompt/builder.js';
import type { ActivationContext } from './activation/activation.js';

export interface ISkillsRegistry {
  list(): SkillManifest[];
  get(name: string): SkillManifest | undefined;
}

export interface ISkillLoader {
  initialize(): void;
  refresh(): void;
  buildPromptBlock(mode?: string, maxChars?: number): string;
  getLoaded(): Array<{ name: string; content: string }>;
  getContent(name: string): string | undefined;
}

export interface ISkillService {
  initialize(): void;
  refresh(): void;

  list(opts?: { includeDisabled?: boolean; origin?: string; tag?: string }): LoadedSkill[];
  listActive(): LoadedSkill[];
  get(name: string): LoadedSkill | undefined;
  executeContent(name: string, args?: SkillExecuteArgs): Promise<SkillExecuteResult | null>;

  createGeneratedSkill(input: SkillDraftInput): SkillManifest;
  createUserSkill(input: { name: string; description: string; content?: string }): SkillManifest;
  importFromUrl(url: string): Promise<SkillManifest>;

  buildPromptBlock(opts?: PromptBuildOptions): string;

  recordView(name: string): void;
  recordOutcome(name: string, success: boolean): void;
  recordPatch(name: string): void;

  updateActivationContext(partial: Partial<ActivationContext>): void;
  dispose(): void;
}
