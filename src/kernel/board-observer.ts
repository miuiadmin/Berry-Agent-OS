/**
 * Brain 主动看板纠偏（架构升级 16.0 P3-A2）—— 设计文档/23 §4.2 + §10.1。
 *
 * 背景：16.0 任务板已有 delegate/report/command/ask/tool_request 5 种信封的投影（fire-and-forget），
 * 但 brain 目前只在 checkpoint 阶段顺带看板——没有「平时异步轻扫板，发现跑偏主动发 command」的能力。
 * BoardObserver 补这个缺口：定时 / 事件触发 getBoardContext 轻扫 → 嗅到风险 → 复用 checkpoint 机制
 * emit 'delegation.checkpoint_needed' 让 brain 介入（brain 介入后再决定是否下 command(redirect)）。
 *
 * 核心设计取舍（硬约束）：
 *   1. 不调 LLM —— 看板轻扫是确定性规则检测（§10.1 分级看板：异常才下钻到 brain LLM）。
 *   2. 不阻塞板上发言 —— 看板异步（§4.2），observeTask 只读不写板。
 *   3. 不直接落 command —— command 只有 brain 能发（CommandMsgSchema.from = 'brain'）。
 *      observer 检测到风险时复用现有 'delegation.checkpoint_needed' 事件，让 brain 经 checkpoint 路径介入。
 *      这避免新造一条 brain 触发路径，符合「架构优雅定律：已有机制能解决就不加新概念」。
 *   4. advisory only —— 所有操作 try/catch，失败仅 logger.warn，绝不影响主路径。
 */

import { getDb } from '../memory/db.js';
import { getLogger } from '../utils/logger.js';
import { getEventBus } from './event-bus.js';
import { getBoardContext } from './board-repo.js';
import type { BoardMessage } from '../contracts/board-message.js';

const logger = getLogger('board-observer');

/**
 * observer 检测到的风险信号种类（用于 checkpoint trigger 字段，便于 brain 区分介入原因）。
 * - drift：turn_count 已逼近 maxTurns 软上限，任务可能在发散
 * - stuck：连续多条 report(blocked)，agent 卡住无法推进
 * - spawn_explosion：同一 agent 连续 delegate 超过 spawnDepth 封顶，递归爆炸风险
 */
type BoardRisk = 'drift' | 'stuck' | 'spawn_explosion';

/** observer 构造注入（与 brain 通信走 EventBus，brainIpc 字段预留给未来 command 直投） */
export interface BoardObserverDeps {
  /** AgentManager（当前未强依赖，预留给未来按成员活跃度过滤扫描目标） */
  agentManager?: unknown;
  /**
   * brain IPC 通道占位（设计文档要求接收，但当前实现走 EventBus 'delegation.checkpoint_needed'
   * 复用现有 checkpoint 机制让 brain 介入，不直接经 brainIpc 发 command——避免新造触发路径）。
   * 保留字段以便后续若需要绕过 checkpoint 直接投 command 时使用，当前可传 undefined。
   */
  brainIpc?: unknown;
}

/** 风险检测阈值（§10.1 分级看板的「轻扫」参数，可调） */
const RISK_THRESHOLDS = {
  /** turn_count 占 maxTurns 的比例超过此值 → 发散风险（默认 0.8） */
  driftRatio: 0.8,
  /** 连续 report(blocked) 条数达到此值 → 卡住（默认 2 条） */
  stuckBlockedStreak: 2,
  /** 同一 agent 连续 delegate 条数达到此值 → 递归爆炸（默认 = maxSpawnDepth，运行时动态读板元） */
  delegateStreakBase: 1,
} as const;

/** 默认扫描间隔（毫秒）—— 30 秒一轮，平衡响应性与轻量（§4.2 看板异步） */
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Brain 主动看板纠偏器。
 *
 * 用法：
 *   const observer = new BoardObserver({ agentManager, brainIpc });
 *   observer.start(30_000);  // 每 30s 扫所有 in_progress 的板
 *   // ... 关停时
 *   observer.stop();
 *
 * 也可单板手动触发（事件驱动场景，如收到 report(blocked) 后立刻扫）：
 *   observer.observeTask(taskId, sessionId);
 */
export class BoardObserver {
  /** 定时器句柄（null = 未启动） */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 当前扫描间隔（毫秒），用于日志诊断 */
  private intervalMs: number = DEFAULT_INTERVAL_MS;

  constructor(private deps: BoardObserverDeps = {}) {}

  /**
   * 扫描单块板：取近 N 条发言 → 确定性规则检测风险 → 嗅到风险 emit checkpoint。
   *
   * @param taskId    板 id（task id）
   * @param sessionId 关联会话 id（写入 checkpoint trigger 上下文，便于 brain 定位）
   */
  observeTask(taskId: string, sessionId?: string): void {
    try {
      const ctx = getBoardContext(taskId, 20);
      if (!ctx) {
        // 板不存在或非 board 类型（普通 task），静默跳过——observer 只看 board
        logger.debug({ taskId }, 'observeTask: 板不存在或非 board，跳过');
        return;
      }

      // 终态板不扫（completed/failed/interrupted/awaiting_user 等都无需纠偏）
      if (isTerminalStatus(ctx.meta.boardStatus)) {
        return;
      }

      const risks = detectRisks(ctx.meta, ctx.recentMessages);
      if (risks.length === 0) {
        // 无风险：debug 级别记录轻扫结果（advisory，不刷 info 日志）
        logger.debug(
          { taskId, turns: ctx.meta.turnCount, maxTurns: ctx.meta.maxTurns, total: ctx.totalMessages },
          'observeTask: 轻扫无风险',
        );
        return;
      }

      // 嗅到风险：不直接落 command（command 只有 brain 能发），
      // 而是 emit 'delegation.checkpoint_needed' 复用现有 checkpoint 机制让 brain 介入。
      // trigger 字段拼入风险种类 + sessionId，brain 介入时可据此决定 redirect/stop/inspect。
      for (const risk of risks) {
        const trigger = buildTrigger(risk, sessionId);
        try {
          getEventBus().emit('delegation.checkpoint_needed', {
            delegationId: taskId,
            trigger,
          });
          logger.warn(
            { taskId, risk, trigger, turns: ctx.meta.turnCount, maxTurns: ctx.meta.maxTurns },
            'observeTask: 嗅到风险，已 emit checkpoint 让 brain 介入',
          );
        } catch (emitErr) {
          // emit 失败绝不影响后续 risk 的检测或主路径
          logger.warn({ taskId, risk, err: emitErr }, 'observeTask: emit checkpoint 失败（advisory，忽略）');
        }
      }
    } catch (err) {
      // 看板是 advisory，所有失败仅 warn，不影响主路径
      logger.warn({ taskId, err }, 'observeTask: 扫描异常（advisory，忽略）');
    }
  }

  /**
   * 启动定时扫描：每 intervalMs 扫一遍所有 in_progress 的板。
   *
   * @param intervalMs 扫描间隔（默认 30s）；过短会增加 SQLite 读压力，过长会延迟纠偏
   */
  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) {
      logger.debug({ intervalMs }, 'start: observer 已在运行，忽略重复启动');
      return;
    }
    this.intervalMs = intervalMs;
    this.timer = setInterval(() => {
      this.scanAllInProgress();
    }, intervalMs);
    logger.info({ intervalMs }, 'BoardObserver 已启动定时看板扫描');
  }

  /** 停止定时扫描（幂等：重复 stop 安全） */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('BoardObserver 已停止定时看板扫描');
  }

  /**
   * 扫描所有 in_progress 的板（定时器回调内部用）。
   * 单板失败不影响其他板（每块板的扫描独立 try/catch）。
   */
  private scanAllInProgress(): void {
    const taskIds = listInProgressBoards();
    if (taskIds.length === 0) {
      logger.debug('scanAllInProgress: 当前无 in_progress 的板');
      return;
    }
    logger.debug({ count: taskIds.length }, 'scanAllInProgress: 开始扫描 in_progress 板');
    for (const { taskId, sessionId } of taskIds) {
      // 每块板独立扫描，单板异常不拖累其他板
      this.observeTask(taskId, sessionId);
    }
  }
}

// ─── 确定性风险检测（不调 LLM，纯规则）───

/**
 * 检测板的风险信号（§4.2 + §10.1）。
 *
 * 三类风险：
 *   a. drift —— turn_count > maxTurns * 0.8：任务可能在发散，逼近预算上限
 *   b. stuck —— 连续 N 条 report(status:'blocked')：agent 卡住无法推进
 *   c. spawn_explosion —— 同一 agent 连续 delegate 超过 spawnDepth 封顶：递归爆炸
 *
 * @param meta      板元数据（含 turnCount/maxTurns/spawnDepth）
 * @param messages  近 N 条发言（按 seq ASC，最近在尾）
 * @returns 命中的风险种类（可能多种叠加）
 */
export function detectRisks(
  meta: { turnCount: number; maxTurns: number; maxSpawnDepth: number },
  messages: BoardMessage[],
): BoardRisk[] {
  const risks: BoardRisk[] = [];

  // (a) 发散风险：turn_count 逼近 maxTurns 软上限
  if (meta.maxTurns > 0 && meta.turnCount >= meta.maxTurns * RISK_THRESHOLDS.driftRatio) {
    risks.push('drift');
  }

  // (b) 卡住：连续多条 report(blocked)（从最近一条往前数连续 blocked）
  if (countTrailingBlocked(messages) >= RISK_THRESHOLDS.stuckBlockedStreak) {
    risks.push('stuck');
  }

  // (c) 递归爆炸：同一 agent 连续 delegate 条数 > spawnDepth 封顶
  // spawnDepth 封顶小（默认 3），连续 delegate 超过它意味着同层 agent 在不断拆子任务，
  // 有递归失控风险
  const maxAllowedDelegateStreak = Math.max(RISK_THRESHOLDS.delegateStreakBase, meta.maxSpawnDepth);
  if (maxConsecutiveDelegateBySameAgent(messages) > maxAllowedDelegateStreak) {
    risks.push('spawn_explosion');
  }

  return risks;
}

/**
 * 统计 messages 末尾连续 report(blocked) 的条数。
 * 「卡住」定义为：最近的发言都是 blocked report（没有 done/partial/tell 打断）。
 */
export function countTrailingBlocked(messages: BoardMessage[]): number {
  let streak = 0;
  // 从尾部往前数连续 blocked report
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === 'report' && m.status === 'blocked') {
      streak++;
    } else {
      // 一旦遇到非 blocked report 的发言，连续被打断
      break;
    }
  }
  return streak;
}

/**
 * 统计同一 agent 连续 delegate 的最大条数。
 * 检测「某个 agent 不断 delegate（拆子任务）」的递归爆炸模式。
 * 连续 = 同一 from agent 的 delegate 之间不被其他发言打断。
 */
export function maxConsecutiveDelegateBySameAgent(messages: BoardMessage[]): number {
  let maxStreak = 0;
  let currentAgent: string | null = null;
  let currentStreak = 0;
  for (const m of messages) {
    if (m.type === 'delegate' && m.from === currentAgent) {
      // 同一 agent 继续 delegate，连续数累加
      currentStreak++;
    } else if (m.type === 'delegate') {
      // 换了一个 agent 在 delegate，重置计数
      currentAgent = m.from;
      currentStreak = 1;
    } else {
      // 非 delegate 发言打断连续性
      currentAgent = null;
      currentStreak = 0;
    }
    if (currentStreak > maxStreak) maxStreak = currentStreak;
  }
  return maxStreak;
}

// ─── 辅助：枚举 in_progress 板 + trigger 拼装 ───

/** 终态板状态集合（这些状态的板不需要纠偏扫描） */
const TERMINAL_BOARD_STATUSES = new Set(['completed', 'failed', 'interrupted']);

/** 判断板状态是否终态（终态板 observer 跳过） */
function isTerminalStatus(status: string): boolean {
  return TERMINAL_BOARD_STATUSES.has(status);
}

/**
 * 列出所有 in_progress 的板（含 sessionId 用于 trigger 上下文）。
 * 直接读 agent_tasks 表（board-repo 未提供 list 接口，这里就近查）。
 */
function listInProgressBoards(): Array<{ taskId: string; sessionId?: string }> {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, session_id FROM agent_tasks
         WHERE board_status = 'in_progress'
         ORDER BY created_at ASC`,
      )
      .all() as Array<{ id: string; session_id?: string }>;
    return rows.map((r) => ({ taskId: r.id, sessionId: r.session_id }));
  } catch (err) {
    // 读失败不致命：observer 是 advisory，下一轮再试
    logger.warn({ err }, 'listInProgressBoards: 查询 in_progress 板失败（advisory，忽略）');
    return [];
  }
}

/**
 * 拼 checkpoint trigger 字符串。
 * 约定格式：`board_<risk>[:<sessionId>]`，brain 介入时可解析 risk 决定动作类型。
 * 例如 board_drift:abc123 → brain 看板后可能下 redirect；board_stuck → 可能 dispatch 援兵。
 */
function buildTrigger(risk: BoardRisk, sessionId?: string): string {
  return sessionId ? `board_${risk}:${sessionId}` : `board_${risk}`;
}
