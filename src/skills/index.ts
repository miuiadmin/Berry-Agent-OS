/**
 * L3 skills — 桶导出（SKILL.md 解析 / 本地发现 / 注册表与渐进披露清单）。
 */

/* 公共类型 */
export type {
  SkillSourceLevel,
  Skill,
  SkillDiagnosticCode,
  SkillDiagnostic,
  SkillsProvider,
  SkillLocation,
  SkillsService,
} from './types.js';

/* SKILL.md 解析与校验 + 显式激活包装（契约篇 §4.2/§4.5） */
export type { SkillFrontmatter } from './skill-md.js';
export {
  splitFrontmatter,
  validateSkillName,
  validateSkillDescription,
  parseSkillMd,
  formatSkillInvocation,
} from './skill-md.js';

/* 本地 FS 发现（契约篇 §4.4）+ 包层 provider（技能包应用，§1.2 第六件） */
export type {
  LocalSkillsProviderOptions,
  DefaultSkillLocationsOptions,
  PackageSkillsProviderOptions,
} from './discovery.js';
export {
  scanSkillLocation,
  createLocalSkillsProvider,
  createPackageSkillsProvider,
  defaultSkillLocations,
} from './discovery.js';

/* 注册表 + 渐进披露清单 + ctx 挂载（骨架篇 §9.2） */
export { renderAvailableSkills, createSkillsService, registerSkillsService } from './registry.js';
export { SKILLS_CHANGE_EVENT } from './types.js';
