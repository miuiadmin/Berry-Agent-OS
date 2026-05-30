import type { ServiceContainer } from '../service-container.js';
import type {
  IpcMessage,
  IpcMessageType,
} from '../types.js';
import type { ToolAuditPayload } from '../../contracts/audit.js';
import type { MemoryQueryPayload, MemoryAddPayload, MemoryDeletePayload } from '../../contracts/memory.js';
import type { CapabilityRequestPayload, CapabilityResponsePayload } from '../../contracts/capabilities.js';
import type { ModelTakeoverRequestPayload, ModelTakeoverRespondPayload } from '../../contracts/model.js';
import { getEventBus } from '../event-bus.js';

interface AgentIpc {
  onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void;
  send: (type: IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean;
}

export type ProxyHandlersDeps = Pick<ServiceContainer, 'auditRecorder' | 'sessionManager' | 'capabilityService' | 'takeoverController' | 'memoryRuntime'>;

export function setupAuditHandler(agentIpc: AgentIpc, agentName: string, deps: ProxyHandlersDeps): void {
  agentIpc.onMessage('tool.audit', (msg: IpcMessage) => {
    const audit = msg.payload as ToolAuditPayload;
    deps.auditRecorder.recordToolCall({ ...audit, agentName });
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
