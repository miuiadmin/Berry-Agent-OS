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

const logger = getLogger('proxy-handlers');

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
