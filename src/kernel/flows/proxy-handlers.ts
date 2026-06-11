import type { ServiceContainer } from '../service-container.js';
import type {
  IpcMessage,
  IpcMessageType,
} from '../types.js';
import type { ToolAuditPayload } from '../../contracts/audit.js';
import type { MemoryQueryPayload, MemoryAddPayload, MemoryDeletePayload } from '../../contracts/memory.js';
import type { CapabilityRequestPayload, CapabilityResponsePayload } from '../../contracts/capabilities.js';
import type { ModelTakeoverRequestPayload, ModelTakeoverRespondPayload } from '../../contracts/model.js';
import type { ICapabilityBus, InvokeContext } from '../../bus/contract.js';
import { getEventBus } from '../event-bus.js';
import { genId } from '../../utils/id.js';
import { getLogger } from '../../utils/logger.js';
import type { ObservationRecorder } from '../observation-recorder.js';
import { getDb } from '../../memory/index.js';
import { getUserPreferences } from '../../memory/user-preferences.js';

const logger = getLogger('proxy-handlers');

interface AgentIpc {
  onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void;
  send: (type: IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean;
}

/** proxy-handlers 的依赖集合；observationRecorder 可选，提供时 tool.audit 会同时写入观察队列 */
export type ProxyHandlersDeps = Pick<ServiceContainer, 'auditRecorder' | 'sessionManager' | 'capabilityService' | 'takeoverController' | 'memoryRuntime'> & {
  /** 13.0 灵魂版：观察队列记录器（可选；提供时 tool_call/tool_result 会持久化到 brain_observations） */
  observationRecorder?: ObservationRecorder;
  /** 13.0 灵魂版：Brain IPC 通道（可选；提供时 tool.audit 会同时向 Brain 进程转发 brain.observe IPC，
   *  让 Brain 进程内的观察队列保持同步。Brain 进程有独立的 SQLite 连接，
   *  内核侧的 ObservationRecorder 写入内核的 SQLite，brain.observe IPC 写入 Brain 的 SQLite。 */
  brainIpc?: AgentIpc;
};

/**
 * 注册 tool.audit IPC handler。
 *
 * 每次工具调用完成后 agent 发送 tool.audit，这里做两件事：
 * 1. 写入审计表（auditRecorder.recordToolCall）— 永久记录
 * 2. 写入观察队列（observationRecorder.record）— Brain C 级审核上下文（13.0 灵魂版）
 */
export function setupAuditHandler(agentIpc: AgentIpc, agentName: string, deps: ProxyHandlersDeps): void {
  agentIpc.onMessage('tool.audit', (msg: IpcMessage) => {
    const audit = msg.payload as ToolAuditPayload;
    // ① 写入审计表（永久记录）
    deps.auditRecorder.recordToolCall({ ...audit, agentName });
    // ② 13.0 灵魂版：写入观察队列，供 Brain C 级审核读取完整工具调用上下文
    if (deps.observationRecorder && audit.sessionId) {
      // 13.0 灵魂版：taskId 可能缺失（非 task 上下文中的工具调用），用 sessionId 兜底
      const obsTaskId = audit.taskId ?? `inline_${audit.sessionId}`;
      try {
        // 工具调用记录（tool_call）
        deps.observationRecorder.record({
          sessionId: audit.sessionId,
          taskId: obsTaskId,
          observationType: 'tool_call',
          fromAgent: agentName,
          content: JSON.stringify({ toolName: audit.toolName, input: typeof audit.toolInput === 'string' ? audit.toolInput.slice(0, 500) : JSON.stringify(audit.toolInput).slice(0, 500) }),
          priority: 1,
        });
        // 工具结果记录（tool_result）
        deps.observationRecorder.record({
          sessionId: audit.sessionId,
          taskId: obsTaskId,
          observationType: 'tool_result',
          fromAgent: agentName,
          content: JSON.stringify({ toolName: audit.toolName, success: !audit.isError, result: typeof audit.toolResult === 'string' ? audit.toolResult.slice(0, 500) : JSON.stringify(audit.toolResult).slice(0, 500), durationMs: audit.durationMs }),
          priority: audit.isError ? 0 : 1, // 错误结果优先级 critical（永不丢弃）
        });
      } catch (err) {
        logger.debug({ err, toolName: audit.toolName }, '观察队列 tool_call/tool_result 写入失败（不影响主流程）');
      }

      // ③ 13.0 §3.2 OBSERVE: 转发 brain.observe IPC 给 Brain 进程
      // Brain 进程有独立的 SQLite 连接，内核侧的 ObservationRecorder 写入内核的 SQLite，
      // Brain 进程需要通过 IPC 接收观察才能写入自己的 SQLite。
      // 这使得 Brain 的 OBSERVE 三段式能正常工作（INTERVENE/REVIEW 从自己的 SQLite 读取）。
      if (deps.brainIpc && audit.sessionId) {
        try {
          const obsTaskId = audit.taskId ?? `inline_${audit.sessionId}`;
          deps.brainIpc.send('brain.observe' as IpcMessageType, 'brain', {
            sessionId: audit.sessionId,
            taskId: obsTaskId,
            observationType: 'tool_call',
            fromAgent: agentName,
            content: JSON.stringify({ toolName: audit.toolName, input: typeof audit.toolInput === 'string' ? audit.toolInput.slice(0, 500) : JSON.stringify(audit.toolInput).slice(0, 500) }),
            priority: audit.isError ? 0 : 1,
          }, genId('obs'));
        } catch (err) {
          // Brain 可能未启动或 IPC 发送失败——观察已在内核 SQLite 中，非致命
          logger.debug({ err: (err as Error).message, toolName: audit.toolName }, 'brain.observe IPC 转发失败（非致命）');
        }
      }
    }

    // ③ 13.0 §5.1.2: 写入 agent_tool_calls 审计表 — per-agent 工具调用记录
    // 该表存储每个 agent 的工具调用详情，包括审批来源（auto/scope/brain/user）
    // 供 Brain C 级审核和前端 agent-chat 面板使用
    if (audit.sessionId) {
      try {
        const db = getDb();
        if (db) {
          const insertStmt = db.prepare(`
            INSERT INTO agent_tool_calls (id, session_id, task_id, agent_name, tool_name, input_summary, success, duration_ms, approved_by, error_message, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          insertStmt.run(
            genId('atc'),
            audit.sessionId,
            audit.taskId ?? '',
            agentName,
            audit.toolName,
            typeof audit.toolInput === 'string' ? audit.toolInput.slice(0, 500) : JSON.stringify(audit.toolInput).slice(0, 500),
            audit.isError ? 0 : 1,
            audit.durationMs ?? null,
            'auto', // 默认 auto 审批；如果经过 scope 预授权则由 scope 层更新为 'scope'
            audit.isError ? (typeof audit.toolResult === 'string' ? audit.toolResult.slice(0, 500) : null) : null,
            Date.now(),
          );
        }
      } catch (err) {
        // 表可能不存在（迁移未执行）— 静默忽略
        logger.debug({ err, toolName: audit.toolName }, 'agent_tool_calls 写入跳过（表不存在或非关键）');
      }
    }

    getEventBus().emit('tool.executed', {
      agentName,
      toolName: audit.toolName,
      durationMs: audit.durationMs,
      isError: audit.isError,
      taskId: audit.taskId,
    });
  });
}

export function setupMemoryHandlers(agentIpc: AgentIpc, agentName: string, deps: ProxyHandlersDeps): void {
  agentIpc.onMessage('memory.query', (msg: IpcMessage) => {
    const { query, type, limit } = msg.payload as MemoryQueryPayload;
    try {
      const results = deps.memoryRuntime.search({ query, type, limit });
      agentIpc.send('memory.query', agentName, { results }, msg.id);
    } catch (err) {
      agentIpc.send('memory.query', agentName, { results: [], error: (err as Error).message }, msg.id);
    }
  });

  agentIpc.onMessage('memory.add', (msg: IpcMessage) => {
    const data = msg.payload as MemoryAddPayload;
    try {
      const entry = deps.memoryRuntime.add(data);
      agentIpc.send('memory.add', agentName, { success: true, id: entry.id }, msg.id);
    } catch (err) {
      agentIpc.send('memory.add', agentName, { success: false, error: (err as Error).message }, msg.id);
    }
  });

  agentIpc.onMessage('memory.delete', (msg: IpcMessage) => {
    const { id } = msg.payload as MemoryDeletePayload;
    try {
      deps.memoryRuntime.delete({ id });
      agentIpc.send('memory.delete', agentName, { success: true }, msg.id);
    } catch (err) {
      agentIpc.send('memory.delete', agentName, { success: false, error: (err as Error).message }, msg.id);
    }
  });

  // 13.0 §5.3.8: Agent 显式请求升级/写入永久用户偏好（如 user.remember_preference）。
  // 之前 messages.ts 定义了此 IPC 但全代码库无 handler，Agent 无法通过 IPC 触发偏好升级。
  agentIpc.onMessage('user.remember_preference', (msg: IpcMessage) => {
    const req = msg.payload as {
      userId?: string; prefKey: string; prefValue: string;
      source?: 'evolution_engine' | 'brain_decision' | 'user_explicit' | 'restore_original';
      confidence?: number; expiresAt?: number | null;
    };
    try {
      const entry = getUserPreferences().set({
        userId: req.userId ?? 'default',
        prefKey: req.prefKey,
        prefValue: req.prefValue,
        source: req.source ?? 'brain_decision',
        confidence: req.confidence ?? 0.8,
        expiresAt: req.expiresAt ?? null,
      });
      agentIpc.send('user.remember_preference', agentName, { ok: true, id: entry?.id ?? req.prefKey }, msg.id);
    } catch (err) {
      agentIpc.send('user.remember_preference', agentName, { ok: false, reason: (err as Error).message }, msg.id);
    }
  });

  // 13.0 §5.3.7: Agent 读取用户偏好（供 system prompt 注入偏好上下文）。
  agentIpc.onMessage('user.get_preferences', (msg: IpcMessage) => {
    const req = msg.payload as { userId?: string; keyPrefix?: string };
    try {
      const prefs = getUserPreferences().list(req.userId ?? 'default', req.keyPrefix);
      agentIpc.send('user.get_preferences', agentName, {
        ok: true,
        preferences: prefs.map(p => ({ key: p.prefKey, value: p.prefValue, source: p.source, confidence: p.confidence })),
      }, msg.id);
    } catch (err) {
      agentIpc.send('user.get_preferences', agentName, { ok: false, reason: (err as Error).message }, msg.id);
    }
  });
}

export function setupCapabilityHandler(agentIpc: AgentIpc, agentName: string, deps: ProxyHandlersDeps): void {
  agentIpc.onMessage('capability.request', (msg: IpcMessage) => {
    try {
      if (!deps.capabilityService) throw new Error('能力服务尚未初始化');
      const result = deps.capabilityService.handle(msg.payload as CapabilityRequestPayload);
      agentIpc.send('capability.response', agentName, { ok: true, result } satisfies CapabilityResponsePayload, msg.id);
    } catch (err) {
      agentIpc.send('capability.response', agentName, {
        ok: false,
        error: (err as Error).message,
      } satisfies CapabilityResponsePayload, msg.id);
    }
  });
}

export function setupModelOverrideHandler(agentIpc: AgentIpc, agentName: string, deps: ProxyHandlersDeps): void {
  agentIpc.onMessage('model.override', (msg: IpcMessage) => {
    const { sessionId, tier } = msg.payload as { sessionId: string; tier: string };
    if (!tier || !['fast', 'default', 'high'].includes(tier)) {
      agentIpc.send('model.override', agentName, { ok: false, error: '无效的模型层级' }, msg.id);
      return;
    }
    deps.sessionManager.setModelOverride(sessionId, tier as import('../../contracts/model.js').ModelTier);
    agentIpc.send('model.override', agentName, { ok: true, sessionId, tier }, msg.id);
  });
}

export function setupTakeoverRouting(agentIpc: AgentIpc, agentName: string, deps: ProxyHandlersDeps): void {
  agentIpc.onMessage('model.takeover.request', (msg: IpcMessage) => {
    if (!deps.takeoverController) {
      agentIpc.send('model.takeover.respond', agentName, {
        requestId: (msg.payload as ModelTakeoverRequestPayload).requestId,
        content: '',
        error: 'Takeover 模式未启用',
      } satisfies ModelTakeoverRespondPayload, msg.id);
      return;
    }

    const payload = msg.payload as ModelTakeoverRequestPayload;
    deps.takeoverController.addRequest(payload, (respondPayload) => {
      agentIpc.send('model.takeover.respond', agentName, respondPayload, msg.id);
    });
  });
}

export function setupBusHandlers(agentIpc: AgentIpc, agentName: string, capabilityBus: ICapabilityBus | null): void {
  agentIpc.onMessage('bus.invoke', (msg: IpcMessage) => {
    if (!capabilityBus) {
      agentIpc.send('bus.invoke.result', agentName, {
        ok: false,
        error: 'Capability Bus not initialized',
        auditId: '',
        durationMs: 0,
        provider: { type: 'builtin', name: 'error' },
      }, msg.correlationId ?? msg.id);
      return;
    }

    const payload = msg.payload as {
      invokeId?: string;
      capabilityName: string;
      input: unknown;
      callerAgent: string;
      sessionId: string;
    };

    const ctx: InvokeContext = {
      callChain: [],
      callerAgent: payload.callerAgent || agentName,
      sessionId: payload.sessionId,
      correlationId: msg.correlationId ?? genId('corr'),
      timeout: 30_000,
    };

    capabilityBus.invoke(payload.capabilityName, payload.input, ctx).then((result) => {
      agentIpc.send('bus.invoke.result', agentName, {
        ...result,
        invokeId: payload.invokeId,
      }, msg.correlationId ?? msg.id);
    }).catch((err) => {
      logger.debug({ err, capability: payload.capabilityName }, 'Bus invoke failed');
      agentIpc.send('bus.invoke.result', agentName, {
        isError: true,
        content: err instanceof Error ? err.message : String(err),
        invokeId: payload.invokeId,
      }, msg.correlationId ?? msg.id);
    });
  });

  agentIpc.onMessage('bus.capabilities.request', (msg: IpcMessage) => {
    if (!capabilityBus) {
      agentIpc.send('bus.capabilities.response', agentName, { tools: [] }, msg.id);
      return;
    }

    const payload = msg.payload as { agentName: string; required: string[] };
    const required = payload.required;

    const tools = required.length > 0
      ? required
          .map((name) => capabilityBus.getDescriptor(name))
          .filter(Boolean)
          .map((cap) => ({
            name: cap!.name,
            description: cap!.description,
            inputSchema: cap!.inputSchema ? {} : {},
          }))
      : capabilityBus.discover({ dangerLevel: 'safe' }).map((cap) => ({
          name: cap.name,
          description: cap.description,
          inputSchema: {},
        }));

    agentIpc.send('bus.capabilities.response', agentName, { tools }, msg.id);
  });
}

export type BusHandlerDeps = {
  capabilityBus: import('../../bus/index.js').ICapabilityBus | null;
};

export function setupBusInvokeHandler(agentIpc: AgentIpc, agentName: string, deps: BusHandlerDeps): void {
  agentIpc.onMessage('bus.invoke' as IpcMessageType, async (msg: IpcMessage) => {
    const { capabilityName, input, callerAgent, sessionId, correlationId } = msg.payload as {
      capabilityName: string;
      input: unknown;
      callerAgent: string;
      sessionId: string;
      correlationId: string;
    };

    if (!deps.capabilityBus) {
      agentIpc.send('bus.invoke.result' as IpcMessageType, agentName, {
        ok: false,
        error: 'Capability Bus not initialized',
        auditId: '',
        durationMs: 0,
        provider: { type: 'builtin', name: 'error' },
      }, msg.id);
      return;
    }

    try {
      const result = await deps.capabilityBus.invoke(capabilityName, input, {
        callChain: [`${callerAgent}:${capabilityName}`],
        callerAgent,
        sessionId,
        correlationId,
      });
      agentIpc.send('bus.invoke.result' as IpcMessageType, agentName, result, msg.id);
    } catch (err) {
      agentIpc.send('bus.invoke.result' as IpcMessageType, agentName, {
        ok: false,
        error: (err as Error).message,
        auditId: '',
        durationMs: 0,
        provider: { type: 'builtin', name: 'error' },
      }, msg.id);
    }
  });

  agentIpc.onMessage('bus.capabilities.request' as IpcMessageType, (msg: IpcMessage) => {
    const { required } = msg.payload as { agentName: string; required: string[] };

    if (!deps.capabilityBus) {
      agentIpc.send('bus.capabilities.response' as IpcMessageType, agentName, { tools: [] }, msg.id);
      return;
    }

    const tools = required
      .map((name: string) => deps.capabilityBus!.getDescriptor(name))
      .filter(Boolean)
      .map((desc: any) => ({
        name: desc.name,
        description: desc.description,
        inputSchema: desc.inputSchema
          ? (typeof desc.inputSchema.toJsonSchema === 'function' ? desc.inputSchema.toJsonSchema() : { type: 'object' })
          : { type: 'object' },
      }));

    agentIpc.send('bus.capabilities.response' as IpcMessageType, agentName, { tools }, msg.id);
  });
}
