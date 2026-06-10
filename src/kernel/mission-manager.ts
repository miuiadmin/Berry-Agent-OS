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
import type {
  Plan, MissionTask, MissionMeta, Decision, SquadFile, Squad, SquadMember,
  TaskStatus, Signal, SignalType, Handoff, PlanUpdate,
} from '../contracts/mission.js';
import { MAX_SQUAD_DEPTH } from '../contracts/mission.js';
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
// MissionManager
// ─────────────────────────────────────────────────────────────────

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

    // ⑦ 检测所有任务完成 → 自动更新 mission 状态
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
   * 读取 squad.json。
   */
  readSquad(missionId: string): SquadFile | null {
    return readJsonFile<SquadFile>(getSquadPath(missionId));
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
   */
  executeHandoff(
    missionId: string,
    fromSquad: string,
    toSquad: string,
    what: string,
    content?: string,
  ): SquadFile | null {
    const squadFile = this.readSquad(missionId);
    if (!squadFile) return null;

    // 查找或创建 handoff 条目
    let handoff = squadFile.handoffs.find(
      h => h.from === fromSquad && h.to === toSquad && h.status === 'pending',
    );

    if (handoff) {
      handoff.status = 'delivered';
      handoff.content = content ?? what;
    } else {
      handoff = {
        from: fromSquad,
        to: toSquad,
        what,
        status: 'delivered',
        content,
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
    const templates = this.loadTemplates();
    const template = templates.find(t => t.name === templateName);
    if (!template) return null;

    // 基于模板创建 mission
    return this.createMission(goal, context, template.plan.tasks.map(t => ({
      what: t.what,
      who: t.who,
      depends_on: t.depends_on,
    })), overrides?.createdBy);
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
