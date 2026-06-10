/**
 * 13.0 多智能体协作 — Mission 任务模板库。
 *
 * §10.8 任务模板库（P4 实施）— 给常见任务类型提供起点。
 * Brain 可以在创建 mission 时基于模板快速生成初始 task 列表，
 * 然后根据具体需求调整。
 *
 * 4 个内置模板：
 *   - code-refactor: 4 tasks（分析→重构→测试→审查）
 *   - feature-dev:   5 tasks（设计→实现→测试→文档→审查）
 *   - bug-fix:       3 tasks（复现→修复→验证）
 *   - full-project:  6 tasks（设计→搭建→实现→测试→文档→审查）
 *
 * 模板是纯函数，不依赖文件系统——便于单测。
 * 用户自定义模板可放在 ~/.berry/templates/mission/<name>.json，
 * 由 MissionManager.loadTemplates() 加载。
 */

import type { MissionTask } from '../contracts/mission.js';

/** 任务模板返回结构（与 createMission 兼容） */
export interface TaskTemplate {
  /** 任务描述 */
  what: string;
  /** 负责 agent */
  who: string;
  /** 依赖的其他任务索引（基于模板内的索引，非 ID） */
  depends_on: number[];
  /** 初始进度说明（可选） */
  progress?: string;
}

/** 模板定义：函数（goal）=> 初始任务列表 */
export type TemplateFn = (goal: string) => TaskTemplate[];

/** 模板元信息 */
export interface TemplateMeta {
  name: string;
  description: string;
  recommendedFor: string;
  taskCount: number;
}

// ─────────────────────────────────────────────────────────────
// 模板实现
// ─────────────────────────────────────────────────────────────

/**
 * code-refactor 模板：4 个任务，串行依赖。
 * 典型场景：重构 auth 模块、清理 utils.ts、拆分 god class。
 */
const codeRefactorTemplate: TemplateFn = (goal) => [
  { what: `分析 ${goal} 的现状：列出文件、函数、调用关系`, who: 'code', depends_on: [] },
  { what: `执行重构：按照分析结果修改代码，保持行为不变`, who: 'code', depends_on: [0] },
  { what: `写测试：覆盖重构涉及的所有路径`, who: 'code', depends_on: [1] },
  { what: `审查：检查代码质量、测试覆盖、可读性`, who: 'code', depends_on: [2] },
];

/**
 * feature-dev 模板：5 个任务，设计/实现/测试/文档/审查。
 * 典型场景：添加新功能、新 API、新端点。
 */
const featureDevTemplate: TemplateFn = (goal) => [
  { what: `设计 ${goal}：明确接口、调用流程、边界条件`, who: 'code', depends_on: [] },
  { what: `实现核心功能代码`, who: 'code', depends_on: [0] },
  { what: `写测试：单元测试 + 集成测试`, who: 'code', depends_on: [1] },
  { what: `写文档：API 文档、用户指南、CHANGELOG`, who: 'skills', depends_on: [1] },
  { what: `最终审查：质量、测试覆盖、文档完整性`, who: 'code', depends_on: [2, 3] },
];

/**
 * bug-fix 模板：3 个任务，复现→修复→验证。
 * 典型场景：fix 一个 bug、修一个 crash、修一个边界条件问题。
 */
const bugFixTemplate: TemplateFn = (goal) => [
  { what: `复现 ${goal}：写最小复现用例，确认触发条件`, who: 'code', depends_on: [] },
  { what: `修复：定位根因、最小化修改`, who: 'code', depends_on: [0] },
  { what: `验证：跑复现用例 + 回归测试，确认不再触发`, who: 'code', depends_on: [1] },
];

/**
 * full-project 模板：6 个任务，完整项目交付。
 * 典型场景：从零搭建一个完整的小项目。
 */
const fullProjectTemplate: TemplateFn = (goal) => [
  { what: `设计 ${goal}：架构、模块划分、技术选型`, who: 'code', depends_on: [] },
  { what: `搭建项目骨架：目录、配置文件、依赖`, who: 'code', depends_on: [0] },
  { what: `实现核心功能`, who: 'code', depends_on: [1] },
  { what: `测试：单元测试 + 集成测试 + 端到端测试`, who: 'code', depends_on: [2] },
  { what: `文档：README、API 文档、用户手册、CHANGELOG`, who: 'skills', depends_on: [2] },
  { what: `最终审查与发布准备`, who: 'code', depends_on: [3, 4] },
];

/** 模板注册表 */
const TEMPLATES: Record<string, TemplateFn> = {
  'code-refactor': codeRefactorTemplate,
  'feature-dev': featureDevTemplate,
  'bug-fix': bugFixTemplate,
  'full-project': fullProjectTemplate,
};

/** 模板元信息 */
const TEMPLATE_METAS: Record<string, TemplateMeta> = {
  'code-refactor': {
    name: 'code-refactor',
    description: '代码重构：分析→重构→测试→审查',
    recommendedFor: '重构现有代码、清理技术债务',
    taskCount: 4,
  },
  'feature-dev': {
    name: 'feature-dev',
    description: '功能开发：设计→实现→测试→文档→审查',
    recommendedFor: '添加新功能、新 API、新端点',
    taskCount: 5,
  },
  'bug-fix': {
    name: 'bug-fix',
    description: 'Bug 修复：复现→修复→验证',
    recommendedFor: '修 bug、crash、边界条件问题',
    taskCount: 3,
  },
  'full-project': {
    name: 'full-project',
    description: '完整项目交付：设计→搭建→实现→测试→文档→审查',
    recommendedFor: '从零搭建完整的小项目',
    taskCount: 6,
  },
};

/**
 * 根据模板名和目标生成初始任务列表。
 * @returns 任务模板数组（用于 MissionManager.createMission 的 taskSpecs 参数）
 * @throws 模板名不存在时
 */
export function renderTemplate(templateName: string, goal: string): TaskTemplate[] {
  const fn = TEMPLATES[templateName];
  if (!fn) {
    const available = Object.keys(TEMPLATES).join(', ');
    throw new Error(`未知模板: ${templateName}。可用: ${available}`);
  }
  return fn(goal);
}

/**
 * 列出所有可用模板的元信息。
 */
export function listTemplates(): TemplateMeta[] {
  return Object.values(TEMPLATE_METAS);
}

/**
 * 获取指定模板的元信息。
 */
export function getTemplateMeta(name: string): TemplateMeta | null {
  return TEMPLATE_METAS[name] ?? null;
}

/**
 * 将 TaskTemplate 数组转换为 MissionManager.createMission 接受的 taskSpecs 格式。
 * depends_on 数组会从索引（[0, 1]）转换为 ID 数组（['t-1', 't-2']）。
 *
 * 注意：使用此函数时必须配合 MissionManager.createFromTemplate，
 * 后者会自动生成 t-1, t-2, ... 形式的 ID。
 */
export function toTaskSpecs(templates: TaskTemplate[]): Array<{ what: string; who: string; depends_on: string[] }> {
  return templates.map((t, idx) => ({
    what: t.what,
    who: t.who,
    // depends_on 是模板内索引，转成 't-N' ID 格式
    depends_on: t.depends_on.map(i => `t-${i + 1}`),
  }));
}
