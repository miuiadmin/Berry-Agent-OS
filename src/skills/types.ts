/**
 * L3 skills — 公共类型（契约篇 §4 技能双层）。
 *
 * 五符号（Skill/SkillSourceLevel/SkillDiagnostic/SkillDiagnosticCode/
 * SkillsProvider）已下沉 contracts/skills.ts（2026-08-27 第三十三批 P2-1 题五：
 * 应用 SDK 面类型住 contracts、实现住本模块），此处再导出保持旧消费面零改动
 * （session-events.ts 下沉先例同构）；本文件保留实现侧类型（SkillsService/
 * SkillLocation/SKILLS_CHANGE_EVENT——服务面与事件名非应用清单引用面）。
 */

import type { Disposer } from '../context/types.js';
import type { Skill, SkillDiagnostic, SkillSourceLevel, SkillsProvider } from '../contracts/skills.js';

// 再导出下沉符号（旧消费面 import 路径不变；第四十二批增 SkillProvenance——晋升溯源）
export type {
  Skill,
  SkillSourceLevel,
  SkillDiagnostic,
  SkillDiagnosticCode,
  SkillProvenance,
  SkillsProvider,
} from '../contracts/skills.js';

/** 技能提供方变更事件名（契约篇 §2.2 增补 6；registerProvider/注销即广播，载荷 = 现行 provider id 清单注册序） */
export const SKILLS_CHANGE_EVENT = 'skills_change' as const;

/** 发现位置（§4.4；扫描根 + 来源层级；project 层仅在目录受信时由调用方注入） */
export interface SkillLocation {
  /** 扫描根目录（绝对路径；不存在 → 零技能零诊断——缺目录是常态非异常） */
  readonly dir: string;
  /** 来源层级（决定同名优先级；同提供方内按列表顺序先到先得） */
  readonly source: SkillSourceLevel;
}

/** ctx.skills 服务面（骨架篇 §9.2；应用经 ctx.get<SkillsService>('skills') 取用） */
export interface SkillsService {
  /** 注册技能提供方（追加序即优先序；返回注销器，幂等） */
  registerProvider(provider: SkillsProvider): Disposer;
  /** 重扫全部提供方并合并（first-wins + 冲突诊断 + symlink 去重）；返回合并产物 */
  refresh(): { skills: readonly Skill[]; diagnostics: readonly SkillDiagnostic[] };
  /** 当前合并产物（上次 refresh 的快照；服务构造后为空，须 refresh 才有内容） */
  list(): readonly Skill[];
  /** 按名取技能（未知名 → undefined） */
  get(name: string): Skill | undefined;
  /** 渐进披露清单（§4.3：<available_skills> XML；隐藏技能排除；无可见技能 → ''） */
  renderAvailableSkills(): string;
  /** 上次 refresh 的诊断快照 */
  diagnostics(): readonly SkillDiagnostic[];
}
