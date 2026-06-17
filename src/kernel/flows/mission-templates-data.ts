/**
 * 16.0 重构——内置任务模板数据（从 mission-manager.ts 提取）。
 * P11: 预定义任务分解 + 依赖 + squad 组织，Brain 基于模板快速创建 mission。
 */

/**
 * 内置模板定义。
 * 每个模板提供预定义的任务分解、依赖关系和 squad 组织。
 * Brain 可以基于模板快速创建 mission，然后根据具体情况调整。
 */
export const BUILTIN_TEMPLATES: Array<{
  name: string;
  description: string;
  plan: { tasks: Array<{ what: string; who: string; depends_on: string[] }> };
  /** P11: squad 模板（可选）。§11.4 支持 squads 内嵌套子 squad（最多 3 层） */
  squads?: Array<{
    name: string; goal: string; leader: string;
    members?: Array<{ agent: string; role: 'work' | 'check'; on: string }>;
    /** §11.4 嵌套子 squad */
    squads?: Array<{ name: string; goal: string; leader: string; members?: Array<{ agent: string; role: 'work' | 'check'; on: string }> }>;
  }>;
}> = [
  {
    name: 'code-refactor',
    description: '代码重构模板：分析 → 重构 → 测试 → 审查（4 任务）',
    plan: {
      tasks: [
        { what: '分析现有代码结构和依赖关系', who: 'code', depends_on: [] },
        { what: '执行重构修改', who: 'code', depends_on: ['t-1'] },
        { what: '编写/更新测试', who: 'code', depends_on: ['t-2'] },
        { what: '审查重构结果', who: 'code', depends_on: ['t-3'] },
      ],
    },
    squads: [
      {
        name: '重构组',
        goal: '完成代码重构和验证',
        leader: 'code',
        members: [{ agent: 'code', role: 'check', on: '审查重构质量和测试覆盖' }],
      },
    ],
  },
  {
    name: 'feature-dev',
    description: '新功能开发模板：设计 → 实现 → 测试 → 文档 → 审查（5 任务）',
    plan: {
      tasks: [
        { what: '功能设计和方案评审', who: 'code', depends_on: [] },
        { what: '实现新功能', who: 'code', depends_on: ['t-1'] },
        { what: '编写功能测试', who: 'code', depends_on: ['t-2'] },
        { what: '编写使用文档', who: 'skills', depends_on: ['t-2'] },
        { what: '最终审查', who: 'code', depends_on: ['t-3', 't-4'] },
      ],
    },
    squads: [
      {
        name: '开发组',
        goal: '实现和测试新功能',
        leader: 'code',
        members: [{ agent: 'code', role: 'check', on: '验证实现和测试质量' }],
      },
      {
        name: '文档组',
        goal: '编写功能使用文档',
        leader: 'skills',
        members: [],
      },
    ],
  },
  {
    name: 'bug-fix',
    description: 'Bug 修复模板：复现 → 修复 → 验证（3 任务）',
    plan: {
      tasks: [
        { what: '复现问题并定位根因', who: 'code', depends_on: [] },
        { what: '实施修复', who: 'code', depends_on: ['t-1'] },
        { what: '验证修复并回归测试', who: 'code', depends_on: ['t-2'] },
      ],
    },
    squads: [
      {
        name: '修复组',
        goal: '定位和修复 Bug',
        leader: 'code',
        members: [{ agent: 'code', role: 'check', on: '验证修复完整性和回归' }],
      },
    ],
  },
  {
    name: 'full-project',
    description: '完整项目模板：设计 → 搭建 → 实现 → 测试 → 文档 → 审查（6 任务）',
    plan: {
      tasks: [
        { what: '架构设计和技术选型', who: 'code', depends_on: [] },
        { what: '项目搭建和基础框架', who: 'code', depends_on: ['t-1'] },
        { what: '核心功能实现', who: 'code', depends_on: ['t-2'] },
        { what: '全面测试', who: 'code', depends_on: ['t-3'] },
        { what: '编写项目文档', who: 'skills', depends_on: ['t-3'] },
        { what: '最终审查', who: 'code', depends_on: ['t-4', 't-5'] },
      ],
    },
    squads: [
      {
        name: '开发组',
        goal: '项目搭建和功能实现',
        leader: 'code',
        members: [{ agent: 'code', role: 'check', on: '代码审查和测试验证' }],
        /** §11.4 二级嵌套：开发组内部分为前端和后端子团队 */
        squads: [
          {
            name: '核心开发小组',
            goal: '搭建基础框架和核心功能',
            leader: 'code',
            members: [{ agent: 'code', role: 'work', on: '实现核心业务逻辑' }],
          },
          {
            name: '测试小组',
            goal: '全面测试和回归',
            leader: 'code',
            members: [{ agent: 'code', role: 'check', on: '验证测试覆盖率和回归' }],
          },
        ],
      },
      {
        name: '文档组',
        goal: '编写项目文档',
        leader: 'skills',
        members: [],
      },
    ],
  },
];
