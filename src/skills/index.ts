export { SkillsRegistry, sanitizeName, validateSkillMarkdown } from './registry.js';
export type {
  SkillManifest,
  SkillDraftInput,
  SkillValidationResult,
  SkillView,
  SkillLinkedFiles,
  SkillStats,
  SkillStatsRow,
  SkillMutationResult,
  SkillOutcome,
  SkillPatch,
  SkillOrigin,
  SkillState,
  SkillCreatedBy,
  SkillVisibility,
} from './types.js';

// === 7-layer system ===
export { SkillService } from './skill-service.js';
export type { SkillServiceDeps, SkillListOptions } from './skill-service.js';

// Layer 1: Storage
export { MtimeCache, SkillTelemetry } from './storage/index.js';

// Layer 2: Discovery
export { SkillDiscovery, createSources } from './discovery/index.js';
export type { DiscoveredSkill, SkillSource, SkillSourceType } from './discovery/index.js';

// Layer 3: Loader
export { SkillContentLoader, SkillFrontmatterSchema, parseFrontmatter, stripFrontmatter } from './loader/index.js';
export type { LoadedSkill, SkillFrontmatter } from './loader/index.js';
export type { SkillLinkedFiles as NewSkillLinkedFiles } from './loader/loader.js';

// Layer 4: Activation
export { ActivationEngine, buildPermissionScope, isToolAllowed } from './activation/index.js';
export type { ActivationContext, SkillPermissionScope } from './activation/index.js';

// Layer 5: Execution
export { SkillExecutor, processTemplateVars, processShellInjections } from './execution/index.js';
export type { SkillExecuteArgs, SkillExecuteResult } from './execution/index.js';

// Layer 6: Prompt
export { SkillPromptBuilder } from './prompt/index.js';
export type { PromptBuildOptions, PromptTier } from './prompt/index.js';

// Contract
export type { ISkillService } from './contract.js';
