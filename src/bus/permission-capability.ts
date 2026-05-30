import type { CapabilityBus } from './capability-bus.js';
import type { CapabilityDescriptor, CapabilityExecutor, InvokeContext } from './contract.js';
import type { PermissionCoordinator } from '../kernel/permission-coordinator.js';
import type { DangerLevel } from '../utils/types.js';

export interface PermissionCapabilityDeps {
  permissionCoordinator: PermissionCoordinator;
  requestBrainJudge: (input: {
    sessionId: string;
    agentName: string;
    toolName: string;
    toolInput: string;
    dangerLevel: DangerLevel;
    taskContext?: string;
  }) => Promise<{ allowed: boolean; reason: string }>;
}

export function registerPermissionCapabilities(bus: CapabilityBus, deps: PermissionCapabilityDeps): void {
  const checkPermission: CapabilityExecutor = async (input, ctx) => {
    const { toolName, toolInput, dangerLevel } = input as {
      toolName: string;
      toolInput: string;
      dangerLevel: DangerLevel;
    };

    const result = deps.permissionCoordinator.acquire({
      agentName: ctx.callerAgent ?? 'unknown',
      sessionId: ctx.sessionId,
      toolName,
      toolInput,
      dangerLevel,
      correlationId: ctx.correlationId,
    });

    if (result.requiresReview) {
      const judgment = await deps.requestBrainJudge({
        sessionId: ctx.sessionId,
        agentName: ctx.callerAgent ?? 'unknown',
        toolName,
        toolInput,
        dangerLevel,
      });
      return { allowed: judgment.allowed, reason: judgment.reason, source: 'brain' };
    }

    return { allowed: result.allowed, tokenId: result.tokenId, reason: result.reason, source: 'auto' };
  };

  const descriptor: CapabilityDescriptor = {
    name: 'system:check_permission',
    description: 'Check and acquire permission for a tool execution. Routes through Permission Gate and Brain judge as needed.',
    dangerLevel: 'safe',
    provider: { type: 'builtin', name: 'permission-system' },
  };

  bus.register(descriptor, checkPermission);

  // Also register a validate-token capability
  const validateToken: CapabilityExecutor = async (input, ctx) => {
    const { tokenId, toolName, toolInput } = input as {
      tokenId: string;
      toolName: string;
      toolInput: string;
    };
    return deps.permissionCoordinator.validate({
      tokenId,
      sessionId: ctx.sessionId,
      agentName: ctx.callerAgent ?? 'unknown',
      toolName,
      toolInput,
    });
  };

  bus.register({
    name: 'system:validate_permission_token',
    description: 'Validate an existing permission token before tool execution.',
    dangerLevel: 'safe',
    provider: { type: 'builtin', name: 'permission-system' },
  }, validateToken);

  // Register consume-token capability
  const consumeToken: CapabilityExecutor = async (input) => {
    const { tokenId } = input as { tokenId: string };
    return deps.permissionCoordinator.consume(tokenId);
  };

  bus.register({
    name: 'system:consume_permission_token',
    description: 'Consume (use) a permission token after successful tool execution.',
    dangerLevel: 'safe',
    provider: { type: 'builtin', name: 'permission-system' },
  }, consumeToken);
}
