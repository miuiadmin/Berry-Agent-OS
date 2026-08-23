/**
 * L3 skills — 公共类型（契约篇 §4 技能双层）。
 *
 * 提示词文档层：SKILL.md 零代码执行，模型 read 后照做；本模块只做
 * 发现 → frontmatter 校验 → 优先级合并 → 渐进披露清单（§4.3/§4.4）。
 * 代码插件层不在本模块（插件契约第 1 节）；两层不混装是硬规则（§4.1）。
 */

import type { Disposer } from '../context/types.js';

/** 技能来源层级（§4.4 优先级 project > user > package；同名 first-wins） */
export type SkillSourceLevel = 'project' | 'user' | 'package';

/** 一个已加载技能（SKILL.md 解析产物；正文原文保留供 read 全文与显式激活） */
export interface Skill {
  /** 技能名（frontmatter name，缺省回落父目录名；校验规则见 skill-md.ts） */
  readonly name: string;
  /** 技能描述（≤1024 必填；渐进披露清单的一行成本） */
  readonly description: string;
  /** 正文指令文档（Markdown；frontmatter 之后的全部内容） */
  readonly content: string;
  /** SKILL.md 绝对路径（清单 location 字段；模型据此 read 全文） */
  readonly filePath: string;
  /** 技能目录（filePath 父目录；技能内相对路径按此解析） */
  readonly baseDir: string;
  /** 来源层级（project / user / package） */
  readonly source: SkillSourceLevel;
  /** 隐藏于模型清单、仅显式 /skill:name 调用（CC 扩展字段，§4.2） */
  readonly disableModelInvocation: boolean;
}

/** 诊断码（稳定词汇；warning 不断流，collision 记录 first-wins 落选者） */
export type SkillDiagnosticCode =
  | 'read-failed' // SKILL.md 读取失败（权限等）
  | 'parse-failed' // YAML frontmatter 解析失败
  | 'invalid-metadata' // name/description 校验不过（技能仍加载，随 pi 宽容度）
  | 'list-failed' // 目录列举失败
  | 'provider-failed' // provider.list() 抛异常（整提供方跳过，不断流）
  | 'collision'; // 同名冲突落选（§4.4 first-wins 诊断）

/** 技能加载诊断（warning = 单点问题不断流；collision = 同名落选记录） */
export interface SkillDiagnostic {
  /** warning / collision 两档（当前仅 warning 一种severity，collision 单列便于过滤） */
  readonly type: 'warning' | 'collision';
  /** 稳定诊断码 */
  readonly code: SkillDiagnosticCode;
  /** 人读信息（中文） */
  readonly message: string;
  /** 关联路径（SKILL.md 文件或扫描目录） */
  readonly path: string;
  /** 同名冲突明细（仅 type='collision' 时携带） */
  readonly collision?: {
    /** 冲突技能名 */
    readonly name: string;
    /** 胜出者（优先级更高）的 SKILL.md 路径 */
    readonly winnerPath: string;
    /** 落选者的 SKILL.md 路径 */
    readonly loserPath: string;
  };
}

/** 技能提供方（骨架篇 §9.2 ctx.skills.registerProvider；本地 FS 为默认 provider） */
export interface SkillsProvider {
  /** 提供方 id（诊断溯源；如 'local-fs'） */
  readonly id: string;
  /** 拉取本提供方的全部技能（服务 refresh 时调用；扫描型 provider 每次现扫） */
  list(): { skills: readonly Skill[]; diagnostics: readonly SkillDiagnostic[] };
}

/** 发现位置（§4.4；扫描根 + 来源层级；project 层仅在目录受信时由调用方注入） */
export interface SkillLocation {
  /** 扫描根目录（绝对路径；不存在 → 零技能零诊断——缺目录是常态非异常） */
  readonly dir: string;
  /** 来源层级（决定同名优先级；同提供方内按列表顺序先到先得） */
  readonly source: SkillSourceLevel;
}

/** ctx.skills 服务面（骨架篇 §9.2；插件经 ctx.get<SkillsService>('skills') 取用） */
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
