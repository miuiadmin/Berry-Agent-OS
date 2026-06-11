/**
 * 13.0 多智能体协作 — Mission + Brain + 交互 API 路由。
 *
 * REST API:
 *   GET    /api/missions                — 列出所有 mission
 *   GET    /api/missions/:id            — 获取单个 mission 详情（含 plan.json）
 *   GET    /api/missions/:id/squad      — 获取 squad 组织结构
 *   GET    /api/missions/:id/signals    — 获取 mission 信号流
 *   GET    /api/missions/templates      — 列出可用任务模板
 *   POST   /api/missions/:id/signal     — 手动发送信号
 *
 *   POST   /api/brain/restore-original  — 还原 Brain 审核修改（§5.3.12）
 *   POST   /api/brain/feedback          — 反馈 Brain 审核问题（§5.3.4）
 *
 *   GET    /api/agent-chat/:sessionId   — 查询 Agent 间对话记录（§5.1.2）
 *
 *   POST   /api/conversation/ask-user-response — 回复 Agent 提问（§5.3.5）
 */

import type { MissionManager } from '../kernel/mission-manager.js';
import type { EventBus } from '../contracts/infrastructure.js';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('mission-api');

/** 路由注册函数类型（与 api-routes.ts 的 route 函数签名一致） */
type RouteFn = (method: string, path: string, handler: (req: any, res: any, url?: URL, params?: Record<string, string>) => void) => void;
type ReadBodyFn = (req: any) => Promise<Record<string, unknown> | unknown>;
type JsonFn = (res: any, data: unknown, status?: number) => void;

/** 注册路由所需的依赖 */
interface MissionApiDeps {
  /** MissionManager 实例（延迟求值） */
  getManager: () => MissionManager | null;
  /** EventBus 实例（延迟求值），用于 emit 还原/反馈事件 */
  getEventBus: () => EventBus | null;
  /** 数据库连接（延迟求值），用于查询 agent_chat_messages */
  getDb: () => DatabaseType | null;
  /** BrainDecisionRecorder（延迟求值），用于记录用户反馈 */
  getBrainDecisionRecorder: () => { record: (input: any) => string | null } | null;
  /** Conversation Agent 的 IPC 通道（延迟求值），用于 restore-original 时同步 in-memory history */
  getConversationIpc?: () => { send: (type: string, to: string, payload: unknown, correlationId?: string) => boolean } | null;
}

/**
 * 注册 mission + brain + agent-chat API 路由。
 *
 * @param route - 路由注册函数
 * @param deps - 依赖注入对象
 * @param readBody - 读取请求体的辅助函数
 * @param json - 写 JSON 响应的辅助函数
 */
export function registerMissionRoutes(
  route: RouteFn,
  deps: MissionApiDeps | (() => MissionManager | null),
  readBody: ReadBodyFn,
  json: JsonFn,
): void {

  /** 兼容旧签名：如果第二个参数是函数，包装为 MissionApiDeps */
  const resolvedDeps: MissionApiDeps = typeof deps === 'function'
    ? { getManager: deps, getEventBus: () => null, getDb: () => null, getBrainDecisionRecorder: () => null }
    : deps;

  /** 安全获取 MissionManager（未初始化时返回 503） */
  function requireManager(res: any): MissionManager | null {
    const mgr = resolvedDeps.getManager();
    if (!mgr) {
      json(res, { error: 'Mission system not initialized' }, 503);
      return null;
    }
    return mgr;
  }

  // ═══════════════════════════════════════════════════
  // Mission 路由
  // ═══════════════════════════════════════════════════

  // ─── GET /api/missions — 列出所有 mission ───

  route('GET', '/missions', (_req, res, url) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const missions = mgr.listMissions();
    // 支持按状态过滤
    const statusFilter = url?.searchParams.get('status');
    const filtered = statusFilter
      ? missions.filter(m => m.status === statusFilter)
      : missions;

    json(res, { items: filtered, total: filtered.length });
  });

  // ─── GET /api/missions/:id — 获取 mission 详情（plan.json） ───

  route('GET', '/missions/:id', (_req, res, _url, params) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const missionId = params?.id;
    if (!missionId) {
      json(res, { error: 'Missing mission ID' }, 400);
      return;
    }

    const plan = mgr.readPlan(missionId);
    if (!plan) {
      json(res, { error: `Mission ${missionId} not found` }, 404);
      return;
    }

    json(res, plan);
  });

  // ─── GET /api/missions/:id/summary — 获取 mission 摘要（用于 system prompt 注入） ───

  route('GET', '/missions/:id/summary', (_req, res, _url, params) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const missionId = params?.id;
    if (!missionId) {
      json(res, { error: 'Missing mission ID' }, 400);
      return;
    }

    const summary = mgr.readSummary(missionId);
    if (!summary) {
      json(res, { error: `Mission ${missionId} not found` }, 404);
      return;
    }

    json(res, { missionId, summary });
  });

  // ─── GET /api/missions/:id/squad — 获取 squad 组织结构 ───

  route('GET', '/missions/:id/squad', (_req, res, _url, params) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const missionId = params?.id;
    if (!missionId) {
      json(res, { error: 'Missing mission ID' }, 400);
      return;
    }

    const squad = mgr.readSquad(missionId);
    if (!squad) {
      json(res, { error: `Squad for mission ${missionId} not found` }, 404);
      return;
    }

    json(res, squad);
  });

  // ─── GET /api/missions/:id/signals — 获取 mission 信号流 ───

  route('GET', '/missions/:id/signals', (_req, res, _url, params) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const missionId = params?.id;
    if (!missionId) {
      json(res, { error: 'Missing mission ID' }, 400);
      return;
    }

    const squad = mgr.readSquad(missionId);
    if (!squad) {
      json(res, { error: `Mission ${missionId} not found` }, 404);
      return;
    }

    // 聚合所有 squad 层级的 signals
    const signals: Array<{ from: string; at: string; type: string; msg: string; squadId?: string }> = [];
    function collectSignals(squadNode: any): void {
      if (squadNode.signals) {
        for (const s of squadNode.signals) {
          signals.push({ ...s, squadId: squadNode.id });
        }
      }
      if (squadNode.squads) {
        for (const sub of squadNode.squads) {
          collectSignals(sub);
        }
      }
    }
    for (const s of squad.org?.squads ?? []) {
      collectSignals(s);
    }
    // 加上全局 signals
    if (squad.signals) {
      for (const s of squad.signals) {
        signals.push(s);
      }
    }

    // 按时间倒序排列
    signals.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    json(res, { missionId, signals });
  });

  // ─── GET /api/missions/templates — 列出可用模板 ───

  route('GET', '/missions/templates', (_req, res) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const templates = mgr.loadTemplates();
    json(res, { items: templates.map(t => ({ name: t.name, taskCount: t.plan.tasks.length })) });
  });

  // ─── POST /api/missions/:id/signal — 手动发送信号 ───

  route('POST', '/missions/:id/signal', async (req, res, _url, params) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const missionId = params?.id;
    if (!missionId) {
      json(res, { error: 'Missing mission ID' }, 400);
      return;
    }

    const body = await readBody(req) as Record<string, unknown>;
    const squadId = body.squad_id as string;
    const from = (body.from as string) || 'user';
    const type = body.type as string;
    const msg = body.msg as string;

    if (!squadId || !type || !msg) {
      json(res, { error: 'Missing required fields: squad_id, type, msg' }, 400);
      return;
    }

    try {
      const validTypes = ['progress', 'done', 'blocker', 'question'] as const;
      if (!validTypes.includes(type as typeof validTypes[number])) {
        json(res, { error: `Invalid signal type: ${type}. Must be one of: ${validTypes.join(', ')}` }, 400);
        return;
      }
      mgr.sendSignal(missionId, squadId, from, type as typeof validTypes[number], msg);
      json(res, { ok: true });
    } catch (err: any) {
      json(res, { error: err.message ?? 'Failed to send signal' }, 400);
    }
  });

  // ═══════════════════════════════════════════════════
  // Brain 审核交互路由（§5.3.12 + §5.3.4）
  // ═══════════════════════════════════════════════════

  // ─── POST /api/brain/restore-original — 用户还原 Brain 审核修改（§5.3.12）
  //
  // 用户点击"还原 Brain 的修改"时调用。
  // Kernel 直接替换回复内容为原始版本，不经过 Brain LLM（快速）。
  // 同时记录到 brain_decisions 供 Brain 后续学习。

  route('POST', '/brain/restore-original', async (req, res) => {
    const bus = resolvedDeps.getEventBus();
    const recorder = resolvedDeps.getBrainDecisionRecorder();
    const conversationIpc = resolvedDeps.getConversationIpc?.();

    const body = await readBody(req) as Record<string, unknown>;
    const sessionId = body.sessionId as string;
    const taskId = body.taskId as string;
    const originalResponse = body.originalResponse as string;

    if (!sessionId || !taskId || !originalResponse) {
      json(res, { error: 'Missing required fields: sessionId, taskId, originalResponse' }, 400);
      return;
    }

    // 通过 EventBus 通知前端还原（前端收到后替换消息内容）
    if (bus) {
      bus.emit('message.responded', {
        sessionId,
        taskId,
        response: originalResponse,
        verdict: 'restored',
        reviewReason: '用户还原了 Brain 的修改',
      });
    }

    // 13.0 §5.3.12: 发 IPC 给 conversation agent，让它同步更新 in-memory history + DB
    // 避免下次 user 消息进来时 history 里仍是 Brain 修改版
    if (conversationIpc) {
      try {
        conversationIpc.send('conversation.restore', 'core', { sessionId, taskId, originalResponse });
        logger.info({ sessionId, taskId, len: originalResponse.length }, 'restore-original: IPC sent to conversation');
      } catch (err) {
        logger.warn({ err, sessionId, taskId }, 'restore-original: IPC send failed');
      }
    }

    // 记录用户覆盖 Brain 决策（供 Brain 后续学习 + 进化系统）
    if (recorder) {
      recorder.record({
        sessionId,
        taskId,
        decisionType: 'review',
        inputSummary: `Brain modify → user restore`,
        outputJson: JSON.stringify({ action: 'user_restore', taskId }),
        outcome: 'bad',
        lesson: '用户对 Brain 的修改不满意，还原为原始回复',
      });
    }

    // 13.0 §5.3.12 + §13.20: 触发 Evolution Engine — 从 restore 推导用户偏好
    // 关键学习信号：用户拒绝 Brain 修改 → Brain 后续类似场景更保守
    if (bus) {
      bus.emit('capability.evolution.request', {
        agentName: 'brain',
        reason: '用户还原 Brain 修改',
        source: 'brain.restore_original',
        sessionId,
        taskId,
        originalResponseSnippet: originalResponse.slice(0, 500),
        createdAt: Date.now(),
      });
      logger.info({ sessionId, taskId }, 'restore-original: evolution triggered');
    }

    json(res, { ok: true, restored: originalResponse });
  });

  // ─── POST /api/brain/feedback — 用户反馈 Brain 审核问题（§5.3.4）
  //
  // 用户点击"反馈 Brain 修改有问题"时调用。
  // 记录到 brain_decisions 表 + 触发进化系统学习。
  // 两个去向（§5.3.4）：
  //   1. Brain 后续类似场景更保守
  //   2. Evolution Agent 提取用户实际偏好并永久化

  route('POST', '/brain/feedback', async (req, res) => {
    const bus = resolvedDeps.getEventBus();
    const recorder = resolvedDeps.getBrainDecisionRecorder();

    const body = await readBody(req) as Record<string, unknown>;
    const sessionId = body.sessionId as string;
    const taskId = body.taskId as string;
    const feedbackType = body.type as string;
    const originalResponse = body.originalResponse as string;
    const modifiedResponse = body.modifiedResponse as string;
    const userComment = body.userComment as string;

    if (!sessionId || !feedbackType) {
      json(res, { error: 'Missing required fields: sessionId, type' }, 400);
      return;
    }

    // 记录用户反馈到 brain_decisions 表
    if (recorder) {
      const lesson = feedbackType === 'brain_modify_wrong'
        ? `用户认为 Brain 修改有问题: ${userComment || '无评论'}。原始: ${(originalResponse || '').slice(0, 100)}`
        : `用户反馈: ${userComment || feedbackType}`;

      recorder.record({
        sessionId,
        taskId: taskId || '',
        decisionType: 'review',
        inputSummary: `Brain ${feedbackType}`,
        outputJson: JSON.stringify({
          feedbackType,
          originalResponse: (originalResponse || '').slice(0, 500),
          modifiedResponse: (modifiedResponse || '').slice(0, 500),
          userComment,
        }),
        outcome: 'bad',
        lesson,
      });
    }

    // 通过 EventBus 发出 brain.feedback 事件（进化系统可订阅学习）
    if (bus) {
      bus.emit('brain.feedback', {
        sessionId,
        taskId,
        feedbackType,
        originalResponse,
        modifiedResponse,
        userComment,
      });

      // 13.0 §5.3.4 + §13.20: 触发 Evolution Engine 提取用户偏好
      // 让 Evolution 从 user feedback 自动推导「Brain 后续类似场景应该 X」
      if (feedbackType === 'brain_modify_wrong' || feedbackType === 'brain_review_wrong') {
        bus.emit('capability.evolution.request', {
          agentName: 'brain',
          reason: `用户反馈 Brain 审核问题: ${feedbackType}`,
          source: 'brain.feedback',
          feedbackType,
          sessionId,
          taskId,
          userComment,
          originalResponseSnippet: (originalResponse ?? '').slice(0, 500),
          modifiedResponseSnippet: (modifiedResponse ?? '').slice(0, 500),
          createdAt: Date.now(),
        });
        logger.info({ sessionId, taskId, feedbackType }, 'brain.feedback: evolution triggered');
      }
    }

    json(res, { ok: true, recorded: true });
  });

  // ═══════════════════════════════════════════════════
  // Agent 间对话记录路由（§5.1.2）
  // ═══════════════════════════════════════════════════

  // ─── GET /api/agent-chat/:sessionId — 查询 Agent 间对话记录 ───
  //
  // 前端 agent-chat 面板从此接口读取数据。
  // 支持按 taskId 过滤 + 分页。

  route('GET', '/agent-chat/:sessionId', (_req, res, url, params) => {
    const db = resolvedDeps.getDb();
    if (!db) {
      json(res, { error: 'Database not available' }, 503);
      return;
    }

    const sessionId = params?.sessionId;
    if (!sessionId) {
      json(res, { error: 'Missing sessionId' }, 400);
      return;
    }

    const taskId = url?.searchParams.get('taskId') ?? undefined;
    const limit = Math.min(Math.max(parseInt(url?.searchParams.get('limit') ?? '100'), 1), 500);
    const offset = Math.max(parseInt(url?.searchParams.get('offset') ?? '0'), 0);

    try {
      // 先检查表是否存在（兼容尚未迁移的数据库）
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_chat_messages'"
      ).get();
      if (!tableCheck) {
        json(res, { items: [], total: 0 });
        return;
      }

      const where = taskId
        ? 'WHERE session_id = ? AND task_id = ?'
        : 'WHERE session_id = ?';
      const args = taskId ? [sessionId, taskId] : [sessionId];

      const total = (db.prepare(
        `SELECT COUNT(*) as cnt FROM agent_chat_messages ${where}`
      ).get(...args) as { cnt: number } | undefined)?.cnt ?? 0;

      const messages = db.prepare(
        `SELECT * FROM agent_chat_messages ${where}
         ORDER BY created_at ASC
         LIMIT ? OFFSET ?`
      ).all(...args, limit, offset);

      json(res, { items: messages, total, limit, offset });
    } catch (err: any) {
      json(res, { error: err.message ?? 'Failed to query agent chat messages' }, 500);
    }
  });

  // ═══════════════════════════════════════════════════
  // 用户回复 Agent 提问路由（§5.3.5）
  // ═══════════════════════════════════════════════════

  // ─── POST /api/conversation/ask-user-response — 用户回复 Agent 的提问 ───
  //
  // 前端 askUser 交互组件提交用户选择时调用。
  // 通过 EventBus 发出 user.ask_response 事件，orchestrator 订阅后 resolve pending request。

  route('POST', '/conversation/ask-user-response', async (req, res) => {
    const bus = resolvedDeps.getEventBus();

    const body = await readBody(req) as Record<string, unknown>;
    const sessionId = body.sessionId as string;
    const taskId = body.taskId as string;
    const correlationId = body.correlationId as string;
    const answer = body.answer as string;

    if (!sessionId || !correlationId || !answer) {
      json(res, { error: 'Missing required fields: sessionId, correlationId, answer' }, 400);
      return;
    }

    // 通过 EventBus 发出回复事件
    if (bus) {
      bus.emit('user.ask_response', {
        sessionId,
        taskId,
        correlationId,
        response: answer,
      });
    }

    json(res, { ok: true });
  });

  // ─── 13.0 §5.3.7: User preferences CRUD（跨 session 持久化） ───
  // GET    /api/preferences?userId=&keyPrefix=  — 列出偏好
  // POST   /api/preferences                       — 设置/更新偏好
  // DELETE /api/preferences/:key?userId=         — 删除单个偏好

  route('GET', '/preferences', async (_req, res, url) => {
    try {
      const { getUserPreferences } = await import('../memory/user-preferences.js');
      const userId = url?.searchParams.get('userId') ?? 'default';
      const keyPrefix = url?.searchParams.get('keyPrefix') ?? undefined;
      const prefs = getUserPreferences().list(userId, keyPrefix);
      json(res, { ok: true, preferences: prefs });
    } catch (err) {
      logger.warn({ err }, 'preferences: list failed');
      json(res, { ok: false, reason: (err as Error).message }, 500);
    }
  });

  route('POST', '/preferences', async (req, res) => {
    try {
      const body = await readBody(req) as Record<string, unknown>;
      const { getUserPreferences } = await import('../memory/user-preferences.js');
      const prefKey = body.prefKey as string;
      const prefValue = body.prefValue as string;
      if (!prefKey || prefValue === undefined) {
        json(res, { ok: false, reason: 'Missing prefKey or prefValue' }, 400);
        return;
      }
      const result = getUserPreferences().set({
        userId: body.userId as string | undefined,
        prefKey,
        prefValue,
        source: (body.source as 'evolution_engine' | 'brain_decision' | 'user_explicit' | 'restore_original' | undefined) ?? 'brain_decision',
        confidence: body.confidence as number | undefined,
        expiresAt: body.expiresAt as number | null | undefined,
      });
      if (!result) {
        json(res, { ok: false, reason: 'set failed' }, 500);
        return;
      }
      json(res, { ok: true, id: result.id });
    } catch (err) {
      logger.warn({ err }, 'preferences: set failed');
      json(res, { ok: false, reason: (err as Error).message }, 500);
    }
  });

  route('DELETE', '/preferences/:key', async (_req, res, _url, params) => {
    try {
      const { getUserPreferences } = await import('../memory/user-preferences.js');
      const userId = new URL(_req.url ?? '', 'http://x').searchParams.get('userId') ?? 'default';
      const key = params?.key;
      if (!key) {
        json(res, { ok: false, reason: 'Missing key' }, 400);
        return;
      }
      const ok = getUserPreferences().delete(userId, key);
      json(res, { ok });
    } catch (err) {
      logger.warn({ err }, 'preferences: delete failed');
      json(res, { ok: false, reason: (err as Error).message }, 500);
    }
  });
}
