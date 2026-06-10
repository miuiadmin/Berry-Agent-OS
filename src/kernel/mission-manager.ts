/**
 * 13.0 多智能体协作 — Mission 生命周期管理器。
 *
 * 职责：
 *   1. 创建 mission（目录 + plan.json 初始化）
 *   2. 读写 plan.json 和 squad.json
 *   3. 更新任务状态并检测依赖满足 → 发出 task_ready 事件
 *   4. 管理 squad 结构（创建子 squad、裂变、深度验证）
 *   5. 处理信号和交接
 *   6. 任务模板加载
 *
 * 存储位置：~/.berry/missions/<mission_id>/plan.json / squad.json
 * 文件操作为同步（JSON 文件不大，无需异步 I/O）。
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAppHome } from '../utils/paths.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import type {
  Plan, MissionTask, MissionMeta, Decision, SquadFile, Squad, SquadMember,
  TaskStatus, Signal, SignalType, Handoff, PlanUpdate, MissionContext,
} from '../contracts/mission.js';
import { MAX_SQUAD_DEPTH, SquadFileSchema, renderMissionContext } from '../contracts/mission.js';
import type { HandoffContext } from '../contracts/delegation.js';
import type { EventBus } from './event-bus.js';

// ─────────────────────────────────────────────────────────────────
// 文件路径辅助
// ─────────────────────────────────────────────────────────────────

/** 获取 missions 根目录 */
function getMissionsDir(): string {
  return join(getAppHome(), 'missions');
}

/** 获取某个 mission 的目录 */
function getMissionDir(missionId: string): string {
  return join(getMissionsDir(), missionId);
}

/** plan.json 路径 */
function getPlanPath(missionId: string): string {
  return join(getMissionDir(missionId), 'plan.json');
}

/** squad.json 路径 */
function getSquadPath(missionId: string): string {
  return join(getMissionDir(missionId), 'squad.json');
}

/** 模板目录路径 */
function getTemplatesDir(): string {
  return join(getAppHome(), 'templates', 'mission');
}

/** JSON 文件安全读取 */
function readJsonFile<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** JSON 文件安全写入（创建目录） */
function writeJsonFile(path: string, data: unknown): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

/** ISO 时间戳 */
function isoNow(): string {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────────
// P11: 内置任务模板（包含 squad 结构）
// ─────────────────────────────────────────────────────────────────

/**
 * 内置模板定义。
 * 每个模板提供预定义的任务分解、依赖关系和 squad 组织。
 * Brain 可以基于模板快速创建 mission，然后根据具体情况调整。
 */
const BUILTIN_TEMPLATES: Array<{
  name: string;
  description: string;
  plan: { tasks: Array<{ what: string; who: string; depends_on: string[] }> };
  /** P11: squad 模板（可选） */
  squads?: Array<{ name: string; goal: string; leader: string; members: Array<{ agent: string; role: 'work' | 'check'; on: string }> }>;
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
      },
      {
        name: '测试组',
        goal: '全面测试和回归',
        leader: 'code',
        members: [],
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

// ─────────────────────────────────────────────────────────────────
// MissionManager
// ─────────────────────────────────────────────────────────────────

const logger = getLogger('mission-manager');

/**
 * Mission 管理器 — 管理 mission 目录、plan.json 和 squad.json 的生命周期。
 *
 * 使用方式：
 *   const mgr = new MissionManager(eventBus);
 *   const plan = mgr.createMission('重构 auth 模块', '用户要求重构...', [
 *     { what: '分析 auth.ts', who: 'code', depends_on: [] },
 *     { what: '写测试', who: 'code', depends_on: ['t-1'] },
 *   ]);
 */
export class MissionManager {
  private eventBus: EventBus | null;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus ?? null;
  }

  /**
   * 创建新 mission。
   *
   * @param goal - 总体目标
   * @param context - 上下文描述
   * @param taskSpecs - 初始任务列表
   * @param createdBy - 创建者（默认 'brain'）
   * @returns 创建好的 plan.json
   */
  createMission(
    goal: string,
    context: string,
    taskSpecs: Array<{ what: string; who: string; depends_on?: string[] }>,
    createdBy: string = 'brain',
  ): Plan {
    // 生成 mission ID（m- 前缀 + 日期 + 随机 ID）
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const missionId = `m-${dateStr}-${genId()}`;

    // 构建初始任务列表
    const tasks: MissionTask[] = taskSpecs.map((spec, idx) => ({
      id: `t-${idx + 1}`,
      what: spec.what,
      who: spec.who,
      status: 'waiting' as const,
      depends_on: spec.depends_on ?? [],
      updated_at: isoNow(),
    }));

    // 构建 plan.json
    const plan: Plan = {
      mission: {
        id: missionId,
        goal,
        created_by: createdBy,
        created_at: isoNow(),
        status: 'in_progress',
        context,
      },
      tasks,
      decisions: [{
        by: createdBy,
        at: isoNow(),
        thought: `创建 mission，分解为 ${tasks.length} 个任务`,
      }],
      notes: [],
    };

    // 写入文件
    mkdirSync(getMissionDir(missionId), { recursive: true });
    writeJsonFile(getPlanPath(missionId), plan);

    // 发出事件
    this.emitEvent('mission.created', {
      missionId,
      goal,
      taskCount: tasks.length,
    });

    return plan;
  }

  /**
   * 读取 plan.json。
   */
  readPlan(missionId: string): Plan | null {
    return readJsonFile<Plan>(getPlanPath(missionId));
  }

  /**
   * 读取 plan 的摘要（用于 system prompt 注入，避免 token 爆炸）。
   *
   * 返回精简版：mission 目标 + 各任务的状态概览。
   */
  readSummary(missionId: string): string | null {
    const plan = this.readPlan(missionId);
    if (!plan) return null;

    const lines: string[] = [
      `Mission: ${plan.mission.goal} (${plan.mission.status})`,
      'Tasks:',
    ];

    for (const task of plan.tasks) {
      const deps = task.depends_on.length > 0 ? ` (depends: ${task.depends_on.join(', ')})` : '';
      const result = task.result ? ` → ${task.result}` : '';
      const progress = task.progress ? ` [${task.progress}]` : '';
      lines.push(`  ${task.id}: [${task.status}] ${task.what} → @${task.who}${deps}${progress}${result}`);
    }

    if (plan.notes.length > 0) {
      lines.push('Notes: ' + plan.notes.join('; '));
    }

    return lines.join('\n');
  }

  /**
   * 更新 plan.json。
   *
   * 支持的操作：
   *   - 更新任务状态/进度/结果
   *   - 新增任务
   *   - 记录决策
   *   - 添加备注
   *   - 更新 mission 整体状态
   */
  updatePlan(missionId: string, updates: PlanUpdate): Plan | null {
    const plan = this.readPlan(missionId);
    if (!plan) return null;

    const now = isoNow();

    // ① 更新 mission 整体状态
    if (updates.mission_status) {
      const oldStatus = plan.mission.status;
      plan.mission.status = updates.mission_status;
      if (oldStatus !== updates.mission_status) {
        this.emitEvent('mission.status_changed', {
          missionId,
          oldStatus,
          newStatus: updates.mission_status,
        });
      }
    }

    // ② 更新现有任务
    if (updates.task_id) {
      const task = plan.tasks.find(t => t.id === updates.task_id);
      if (task) {
        const oldStatus = task.status;
        if (updates.status) task.status = updates.status;
        if (updates.progress) task.progress = updates.progress;
        if (updates.result) task.result = updates.result;
        task.updated_at = now;

        // 任务状态变更事件
        if (updates.status && oldStatus !== updates.status) {
          this.emitEvent('mission.task_updated', {
            missionId,
            taskId: task.id,
            status: task.status,
            who: task.who,
          });
        }
      }
    }

    // ③ 新增任务
    if (updates.new_task) {
      const nextIdx = plan.tasks.length + 1;
      const newTask: MissionTask = {
        id: `t-${nextIdx}`,
        what: updates.new_task.what,
        who: updates.new_task.who,
        status: 'waiting',
        depends_on: updates.new_task.depends_on,
        updated_at: now,
      };
      plan.tasks.push(newTask);
    }

    // ④ 记录决策
    if (updates.decision) {
      plan.decisions.push({
        by: 'agent', // 调用者自行在 thought 里标明身份
        at: now,
        thought: updates.decision.thought,
      });
    }

    // ⑤ 添加备注
    if (updates.note) {
      plan.notes.push(updates.note);
    }

    // 写回文件
    writeJsonFile(getPlanPath(missionId), plan);

    // ⑥ 检测任务依赖满足 → 发出 task_ready 事件
    this.checkAndEmitReadyTasks(missionId, plan);

    // ⑦ P5: 自进化 wiring — who:skills 的 task 完成后触发技能创建
    if (updates.task_id && updates.status === 'done') {
      const task = plan.tasks.find(t => t.id === updates.task_id);
      if (task && task.who === 'skills' && task.result) {
        /** 能力进化事件 — evolution 系统订阅后可自动创建新技能 */
        this.emitEvent('capability.evolution.request', {
          missionId,
          taskId: task.id,
          skillDescription: task.result,
        });
      }
    }

    // ⑧ 检测所有任务完成 → 自动更新 mission 状态
    if (plan.mission.status === 'in_progress') {
      const allDone = plan.tasks.every(t => t.status === 'done');
      const anyFailed = plan.tasks.some(t => t.status === 'failed');
      if (allDone) {
        plan.mission.status = 'completed';
        writeJsonFile(getPlanPath(missionId), plan);
        this.emitEvent('mission.completed', { missionId, goal: plan.mission.goal });
      } else if (anyFailed && plan.tasks.every(t => t.status === 'done' || t.status === 'failed')) {
        plan.mission.status = 'failed';
        writeJsonFile(getPlanPath(missionId), plan);
      }
    }

    return plan;
  }

  /**
   * 读取 squad.json（带 runtime schema 验证）。
   * 如果文件内容不符合 SquadFileSchema，返回 null 并记录警告。
   */
  readSquad(missionId: string): SquadFile | null {
    try {
      const raw = readJsonFile<unknown>(getSquadPath(missionId));
      if (!raw) return null;
      /** P1-3 修复：runtime 验证防止 malformed JSON 导致下游崩溃 */
      return SquadFileSchema.parse(raw);
    } catch (err) {
      logger.warn({ err, missionId }, 'readSquad: squad.json 格式非法');
      return null;
    }
  }

  /**
   * 初始化 squad.json（Brain 在创建 mission 时可选地创建 squad 结构）。
   */
  initSquad(missionId: string, squads: Squad[], handoffs: Handoff[] = []): SquadFile | null {
    const plan = this.readPlan(missionId);
    if (!plan) return null;

    const squadFile: SquadFile = {
      mission: plan.mission,
      org: { squads },
      handoffs,
      signals: [],
    };

    writeJsonFile(getSquadPath(missionId), squadFile);
    return squadFile;
  }

  /**
   * 创建新的 squad（leader 裂变时调用）。
   * 深度硬限制在此方法中强制执行。
   */
  createSquad(
    missionId: string,
    squad: {
      name: string;
      goal: string;
      parentSquadId?: string;
      leader: string;
      members?: Array<{ agent: string; role: 'work' | 'check'; on: string }>;
    },
  ): SquadFile | null {
    let squadFile = this.readSquad(missionId);

    /** 如果 squad.json 不存在，自动初始化空结构（第一次 createSquad 时） */
    if (!squadFile) {
      const plan = this.readPlan(missionId);
      if (!plan) return null;
      squadFile = {
        mission: plan.mission,
        org: { squads: [] },
        handoffs: [],
        signals: [],
      };
    }

    // 确定新 squad 的深度
    let depth = 1;
    if (squad.parentSquadId) {
      const parent = this.findSquad(squadFile.org.squads, squad.parentSquadId);
      if (!parent) return null; // 父 squad 不存在
      depth = parent.depth + 1;

      // 深度硬限制（§11.4）
      if (depth > MAX_SQUAD_DEPTH) {
        throw new Error(`squad depth limit exceeded: parent depth=${parent.depth}, new depth=${depth} > max ${MAX_SQUAD_DEPTH}`);
      }
    }

    // 生成 squad ID
    const squadId = this.generateSquadId(squadFile.org.squads, squad.parentSquadId);

    const newSquad: Squad = {
      id: squadId,
      name: squad.name,
      depth,
      goal: squad.goal,
      leader: squad.leader,
      members: (squad.members ?? []).map(m => ({
        agent: m.agent,
        role: m.role,
        on: m.on,
        status: 'idle' as const,
      })),
      status: 'waiting',
      signals: [],
    };

    // 插入到组织树中
    if (squad.parentSquadId) {
      const parent = this.findSquad(squadFile.org.squads, squad.parentSquadId);
      if (parent) {
        if (!parent.squads) parent.squads = [];
        parent.squads.push(newSquad);
      }
    } else {
      squadFile.org.squads.push(newSquad);
    }

    writeJsonFile(getSquadPath(missionId), squadFile);

    this.emitEvent('mission.squad_created', {
      missionId,
      squadId,
      parentSquadId: squad.parentSquadId,
    });

    return squadFile;
  }

  /**
   * 更新 squad 中某个成员的状态。
   */
  updateMember(
    missionId: string,
    squadId: string,
    agentName: string,
    status: 'idle' | 'working' | 'done' | 'failed',
    result?: string,
  ): SquadFile | null {
    const squadFile = this.readSquad(missionId);
    if (!squadFile) return null;

    const squad = this.findSquad(squadFile.org.squads, squadId);
    if (!squad) return null;

    const member = squad.members.find(m => m.agent === agentName);
    if (!member) return null;

    member.status = status;
    if (result) member.result = result;

    writeJsonFile(getSquadPath(missionId), squadFile);
    return squadFile;
  }

  /**
   * 发送信号（同时写入 squad.signals 和全局 signals）。
   */
  sendSignal(
    missionId: string,
    squadId: string,
    from: string,
    type: SignalType,
    msg: string,
  ): SquadFile | null {
    const squadFile = this.readSquad(missionId);
    if (!squadFile) return null;

    const signal: Signal = {
      from,
      at: isoNow(),
      type,
      msg,
    };

    // 写入 squad 内部 signals
    const squad = this.findSquad(squadFile.org.squads, squadId);
    if (squad) {
      squad.signals.push(signal);
    }

    // 同时写入全局 signals（聚合视图）
    squadFile.signals.push(signal);

    writeJsonFile(getSquadPath(missionId), squadFile);

    this.emitEvent('mission.signal', {
      missionId,
      squadId,
      type,
      msg,
    });

    return squadFile;
  }

  /**
   * 执行交接（from squad → to squad）。
   *
   * 如果调用方传入了 sourceContext（HandoffContext），把它一并写到 handoff.content
   * 让接班的 Agent 在 entry 处读取并拼接到 system prompt。
   */
  executeHandoff(
    missionId: string,
    fromSquad: string,
    toSquad: string,
    what: string,
    content?: string,
    sourceContext?: HandoffContext,
  ): SquadFile | null {
    const squadFile = this.readSquad(missionId);
    if (!squadFile) return null;

    // handoff.content 优先使用 sourceContext 的 JSON 序列化（结构化上下文），
    // 回退到原始 content 字符串。
    const handoffContent = sourceContext
      ? JSON.stringify(sourceContext)
      : (content ?? what);

    // 查找或创建 handoff 条目
    let handoff = squadFile.handoffs.find(
      h => h.from === fromSquad && h.to === toSquad && h.status === 'pending',
    );

    if (handoff) {
      handoff.status = 'delivered';
      handoff.content = handoffContent;
    } else {
      handoff = {
        from: fromSquad,
        to: toSquad,
        what,
        status: 'delivered',
        content: handoffContent,
      };
      squadFile.handoffs.push(handoff);
    }

    writeJsonFile(getSquadPath(missionId), squadFile);

    this.emitEvent('mission.handoff', {
      missionId,
      from: fromSquad,
      to: toSquad,
      what,
    });

    return squadFile;
  }

  /**
   * 读取最近一次 from→to 的 handoff，并尝试反序列化为 HandoffContext。
   * 接班的 Agent 在 entry 处调用此方法，把结构化上下文注入到 system prompt。
   *
   * @returns HandoffContext 或 null（没有 handoff / JSON 解析失败）
   */
  readLatestHandoffContext(missionId: string, fromSquad: string, toSquad: string): HandoffContext | null {
    const squadFile = this.readSquad(missionId);
    if (!squadFile) return null;

    // 找到最新的 from→to handoff
    const candidates = squadFile.handoffs.filter(
      h => h.from === fromSquad && h.to === toSquad,
    );
    if (candidates.length === 0) return null;

    const latest = candidates[candidates.length - 1];
    if (!latest.content) return null;

    try {
      return JSON.parse(latest.content) as HandoffContext;
    } catch {
      // 内容不是 JSON，回退到字符串透传
      return {
        originalInstruction: latest.content,
        filesRead: [],
        filesModified: [],
        agentConversations: [],
        currentProgress: latest.what,
        blockers: [],
        handoffAt: new Date(latest.content ?? '').getTime?.() ?? Date.now(),
        fromAgent: fromSquad,
      };
    }
  }

  /**
   * 把 HandoffContext 渲染为一段 system prompt 文本（便于 Agent 直接拼到 prompt）。
   */
  renderHandoffContext(ctx: HandoffContext): string {
    const lines: string[] = [];
    lines.push(`## 交接上下文（来自 ${ctx.fromAgent}）`);
    lines.push(`原始指令: ${ctx.originalInstruction}`);
    lines.push(`当前进度: ${ctx.currentProgress}`);

    if (ctx.intentAnchor) {
      lines.push(`意图锚: ${ctx.intentAnchor.goal}`);
      if (ctx.intentAnchor.successCriteria.length > 0) {
        lines.push(`成功标准: ${ctx.intentAnchor.successCriteria.join('; ')}`);
      }
    }

    if (ctx.filesRead.length > 0) {
      lines.push(`已读文件（避免重复读）:`);
      for (const f of ctx.filesRead) lines.push(`  - ${f}`);
    }
    if (ctx.filesModified.length > 0) {
      lines.push(`已改文件:`);
      for (const f of ctx.filesModified) lines.push(`  - ${f.path}${f.diffHash ? ` (${f.diffHash})` : ''}`);
    }

    if (ctx.agentConversations.length > 0) {
      lines.push(`与其他 Agent 的对话（最近 ${ctx.agentConversations.length} 条）:`);
      for (const c of ctx.agentConversations) {
        lines.push(`  - ${c.with}: ${c.summary}`);
      }
    }

    if (ctx.blockers.length > 0) {
      lines.push(`已知阻塞:`);
      for (const b of ctx.blockers) {
        lines.push(`  - ${b.reason}（${b.raisedBy}）`);
      }
    }

    if (ctx.scopeSnapshot) {
      if (ctx.scopeSnapshot.blockPaths.length > 0) {
        lines.push(`不可访问路径: ${ctx.scopeSnapshot.blockPaths.join(', ')}`);
      }
      if (ctx.scopeSnapshot.blockTools.length > 0) {
        lines.push(`不可用工具: ${ctx.scopeSnapshot.blockTools.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * §12.3/§12.6: 为指定 (mission, task, agent) 组装 MissionContext —
   * 用于注入到 Agent 的 system prompt。
   *
   * 数据流：
   *   1. 读 plan.json 拿到 mission 目标和任务列表
   *   2. 读 squad.json 找到 agentName 所在的 squad 和 role
   *   3. 抽取队友（不含自己）、已完成任务、进行中任务、未解决信号
   *   4. 返回 MissionContext 或 null（如果 mission/task/agent 任一找不到）
   *
   * @param missionId - Mission ID
   * @param planTaskId - 当前 plan task ID（t-1, t-2...）
   * @param agentName - 当前 Agent 类型名（code/learning/skills...）
   * @returns MissionContext 或 null
   */
  readContext(missionId: string, planTaskId: string, agentName: string): MissionContext | null {
    const plan = this.readPlan(missionId);
    if (!plan) return null;

    const task = plan.tasks.find(t => t.id === planTaskId);
    if (!task) return null;

    const squadFile = this.readSquad(missionId);

    // 查找当前 Agent 所在的 squad 和 member
    let member: SquadMember | null = null;
    let parentSquad: Squad | null = null;
    if (squadFile) {
      const found = this.findSquadAndMember(squadFile.org.squads, agentName);
      if (found) {
        member = found.member;
        parentSquad = found.squad;
      }
    }

    // 如果 agent 不在任何 squad 中，给一个默认 work 角色（plan-only 模式）
    const role: 'lead' | 'work' | 'check' = member?.role ?? 'work';
    const on = member?.on ?? task.what;
    const squadGoal = parentSquad?.goal ?? plan.mission.goal;

    // 抽取队友（不含自己）
    const squadTeammates: MissionContext['squadTeammates'] = [];
    if (parentSquad) {
      // members 不含 leader；统一展示
      for (const m of parentSquad.members) {
        if (m.agent === agentName) continue;
        squadTeammates.push({
          agent: m.agent,
          role: m.role,
          on: m.on,
          status: m.status,
        });
      }
      // 也加上 leader（如果不是自己，且没在 members 里出现过）
      if (parentSquad.leader !== agentName && !parentSquad.members.some(m => m.agent === parentSquad.leader)) {
        squadTeammates.push({
          agent: parentSquad.leader,
          role: 'lead',
          on: parentSquad.goal,
          status: parentSquad.status === 'working' ? 'working' : 'idle',
        });
      }
    }

    // 已完成的前置任务
    const completedTasks: MissionContext['completedTasks'] = plan.tasks
      .filter(t => t.status === 'done' && t.id !== planTaskId)
      .map(t => ({ id: t.id, what: t.what, result: t.result }));

    // 同期进行中的任务
    const inProgressTasks: MissionContext['inProgressTasks'] = plan.tasks
      .filter(t => t.status === 'working' && t.id !== planTaskId)
      .map(t => ({ id: t.id, what: t.what, who: t.who, progress: t.progress }));

    // 未解决信号（blocker / question）
    const unresolvedSignals: MissionContext['unresolvedSignals'] = [];
    if (squadFile) {
      for (const sig of squadFile.signals) {
        if (sig.resolved) continue;
        if (sig.type === 'blocker' || sig.type === 'question') {
          unresolvedSignals.push({
            from: sig.from,
            type: sig.type,
            msg: sig.msg,
            at: sig.at,
          });
        }
      }
    }

    return {
      missionId,
      goal: plan.mission.goal,
      currentTaskId: task.id,
      currentTaskWhat: task.what,
      squadRole: role,
      squadOn: on,
      squadGoal,
      squadTeammates,
      completedTasks,
      inProgressTasks,
      unresolvedSignals,
    };
  }

  /**
   * 渲染 MissionContext 为 system prompt 文本（便利方法，等价于 renderMissionContext）。
   * 返回 null 表示 missionId/planTaskId/agentName 至少有一个找不到。
   */
  renderContext(missionId: string, planTaskId: string, agentName: string): string | null {
    const ctx = this.readContext(missionId, planTaskId, agentName);
    if (!ctx) return null;
    return renderMissionContext(ctx);
  }

    /**
   * 递归查找 agentName 所在的 squad 和 member 记录。
   * 注意：squad.leader 不在 members 数组里，所以这里也匹配 leader。
   * 如果 agentName 是 leader，返回一个合成的 {role: 'lead'} member。
   */
  private findSquadAndMember(
    squads: Squad[],
    agentName: string,
  ): { squad: Squad; member: SquadMember } | null {
    for (const squad of squads) {
      // ① 匹配 leader（leader 不在 members 数组里）
      if (squad.leader === agentName) {
        return {
          squad,
          member: {
            agent: agentName,
            role: 'lead',
            on: squad.goal,
            status: squad.status === 'working' ? 'working' : 'idle',
          },
        };
      }
      // ② 匹配 members 列表
      const member = squad.members.find(m => m.agent === agentName);
      if (member) return { squad, member };
      // ③ 递归子 squad
      if (squad.squads) {
        const nested = this.findSquadAndMember(squad.squads, agentName);
        if (nested) return nested;
      }
    }
    return null;
  }

  /**
   * P10: 找到 plan task 所在 squad 的 checker 成员。
   *
   * 流程：
   *   1. 读 plan.json 找 task 关联的 planTask
   *   2. 读 squad.json 找 task.who 所在的 squad
   *   3. 在该 squad 的 members 中找 role='check' 的成员
   *
   * @returns checker 成员信息（含 agent/on/role），没有就返回 null
   */
  getCheckerForPlanTask(missionId: string, planTaskId: string): SquadMember | null {
    const plan = this.readPlan(missionId);
    if (!plan) return null;
    const task = plan.tasks.find(t => t.id === planTaskId);
    if (!task) return null;

    const squadFile = this.readSquad(missionId);
    if (!squadFile) return null;

    // 找到 task.who 所在的 squad
    const found = this.findSquadAndMember(squadFile.org.squads, task.who);
    if (!found) return null;

    // 在该 squad 的 members（含 leader 合成）里找 check 角色
    const candidates: SquadMember[] = [...found.squad.members];
    if (found.squad.leader === task.who) {
      // task 执行者是 leader — 仍然可以派给 squad 内的 check member
    } else {
      // task 执行者就是某 member — 该 member 自己不该再被 check（self-check 没意义）
    }
    const checker = candidates.find(m => m.role === 'check');
    return checker ?? null;
  }

  /**
   * P10: 列出 squad 内所有 check 角色成员（用于 brain 在 review 时决定派给谁）。
   */
  listCheckersForSquad(missionId: string, squadId: string): SquadMember[] {
    const squadFile = this.readSquad(missionId);
    if (!squadFile) return [];
    const found = this.findSquad(squadFile.org.squads, squadId);
    if (!found) return [];
    return found.members.filter(m => m.role === 'check');
  }

  /**
   * 列出所有活跃 mission。
   */
  listMissions(): Array<{ id: string; goal: string; status: string; taskCount: number }> {
    const dir = getMissionsDir();
    if (!existsSync(dir)) return [];

    const results: Array<{ id: string; goal: string; status: string; taskCount: number }> = [];
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const plan = readJsonFile<Plan>(join(dir, entry.name, 'plan.json'));
      if (plan) {
        results.push({
          id: plan.mission.id,
          goal: plan.mission.goal,
          status: plan.mission.status,
          taskCount: plan.tasks.length,
        });
      }
    }

    return results;
  }

  /**
   * 加载任务模板。
   *
   * 模板目录：~/.berry/templates/mission/
   * 返回所有可用模板的内容。
   */
  loadTemplates(): Array<{ name: string; plan: Plan }> {
    const dir = getTemplatesDir();
    if (!existsSync(dir)) return [];

    const results: Array<{ name: string; plan: Plan }> = [];
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const plan = readJsonFile<Plan>(join(dir, file));
      if (plan) {
        results.push({ name: file.replace('.json', ''), plan });
      }
    }

    return results;
  }

  /**
   * 基于模板创建 mission。
   *
   * 模板是起点，Brain 根据具体情况修改。
   */
  createFromTemplate(
    templateName: string,
    goal: string,
    context: string,
    overrides?: { createdBy?: string },
  ): Plan | null {
    /** 先尝试文件系统模板，再尝试内置模板 */
    const fsTemplates = this.loadTemplates();
    const template = fsTemplates.find(t => t.name === templateName)
      ?? BUILTIN_TEMPLATES.find(t => t.name === templateName);
    if (!template) return null;

    // 基于模板创建 mission
    return this.createMission(goal, context, template.plan.tasks.map(t => ({
      what: t.what,
      who: t.who,
      depends_on: t.depends_on,
    })), overrides?.createdBy);
  }

  /**
   * P11: 列出所有可用模板（文件系统 + 内置）。
   *
   * @returns 模板名称和描述列表
   */
  listAllTemplates(): Array<{ name: string; description: string; taskCount: number }> {
    const fsTemplates = this.loadTemplates().map(t => ({
      name: t.name,
      description: t.plan.mission.goal || t.name,
      taskCount: t.plan.tasks.length,
    }));

    /** 内置模板（去重：文件系统同名模板优先） */
    const fsNames = new Set(fsTemplates.map(t => t.name));
    const builtin = BUILTIN_TEMPLATES
      .filter(t => !fsNames.has(t.name))
      .map(t => ({
        name: t.name,
        description: t.description,
        taskCount: t.plan.tasks.length,
      }));

    return [...fsTemplates, ...builtin];
  }

  // ─── 内部方法 ───

  /**
   * 递归查找 squad 树中的指定 squad。
   */
  private findSquad(squads: Squad[], squadId: string): Squad | null {
    for (const squad of squads) {
      if (squad.id === squadId) return squad;
      if (squad.squads) {
        const found = this.findSquad(squad.squads, squadId);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * 生成 squad ID。
   * 规则：同层级按 s-{parent}-{字母序号}，顶级用 s-{数字序号}。
   */
  private generateSquadId(squads: Squad[], parentId?: string): string {
    if (!parentId) {
      // 顶级 squad：s-1, s-2, ...
      const topCount = squads.length + 1;
      return `s-${topCount}`;
    }
    // 子 squad：在父 ID 后加字母后缀
    const parent = this.findSquad(squads, parentId);
    if (!parent) return `s-${genId()}`;
    const siblingCount = parent.squads?.length ?? 0;
    const suffix = String.fromCharCode(97 + siblingCount); // a, b, c, ...
    return `${parentId}${suffix}`;
  }

  /**
   * 检测任务依赖是否满足 → 发出 task_ready 事件。
   *
   * 当某个 task 的 depends_on 全部 done 时，该 task 可以开始执行。
   * 通过 EventBus 通知负责的 agent。
   */
  private checkAndEmitReadyTasks(missionId: string, plan: Plan): void {
    for (const task of plan.tasks) {
      if (task.status !== 'waiting') continue;
      if (task.depends_on.length === 0) continue;

      // 检查所有依赖是否都已完成
      const allDepsDone = task.depends_on.every(depId => {
        const dep = plan.tasks.find(t => t.id === depId);
        return dep?.status === 'done';
      });

      if (allDepsDone) {
        this.emitEvent('mission.task_ready', {
          missionId,
          taskId: task.id,
          who: task.who,
          what: task.what,
        });
      }
    }
  }

  /**
   * 安全地发出事件（eventBus 可能为 null）。
   */
  private emitEvent(type: string, payload: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit(type as any, payload as any);
    }
  }
}
