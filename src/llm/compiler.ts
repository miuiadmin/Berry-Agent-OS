import { createHash } from 'node:crypto';
import type {
  ModelRequest,
  ModelMessage,
  ModelToolDef,
  ModelPurpose,
  ModelTier,
  ModelMode,
  ModelBackendKind,
  ModelApiKind,
  ModelRequestOptions,
  BundledModelPurpose,
} from '../contracts/model.js';
import { PURPOSE_TIER_MAP, BUNDLED_MODEL_PURPOSES } from '../contracts/model.js';
import type { AgentName } from '../contracts/agents.js';
import { genId } from '../utils/id.js';

export interface CompileRequestInput {
  agent: AgentName;
  purpose: ModelPurpose;
  modelTier?: ModelTier;
  sessionId: string;
  taskId?: string;
  correlationId?: string;
  system?: string;
  messages: ModelMessage[];
  tools?: ModelToolDef[];
  options?: Partial<ModelRequestOptions>;
  mode?: ModelMode;
  backend?: ModelBackendKind;
  apiKind?: ModelApiKind;
}

const stepCounters = new Map<string, number>();
const MAX_STEP_ENTRIES = 1024;

export function compileRequest(input: CompileRequestInput): ModelRequest {
  const stepKey = `${input.agent}:${input.sessionId}`;
  const stepIndex = stepCounters.get(stepKey) ?? 0;
  stepCounters.set(stepKey, stepIndex + 1);

  if (stepCounters.size > MAX_STEP_ENTRIES) {
    const keys = [...stepCounters.keys()];
    for (let i = 0; i < keys.length - MAX_STEP_ENTRIES; i++) {
      stepCounters.delete(keys[i]);
    }
  }

  const promptHash = computePromptHash(input.system, input.messages);
  const toolsHash = input.tools?.length ? computeToolsHash(input.tools) : undefined;
  const modelTier = input.modelTier ?? deriveTierFromPurpose(input.purpose);

  return {
    id: genId('req'),
    agent: input.agent,
    purpose: input.purpose,
    modelTier,
    mode: input.mode ?? 'live',
    backend: input.backend ?? 'anthropic',
    apiKind: input.apiKind ?? 'standard',
    sessionId: input.sessionId,
    taskId: input.taskId,
    correlationId: input.correlationId ?? genId('cor'),
    stepIndex,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    options: {
      maxTokens: input.options?.maxTokens,
      temperature: input.options?.temperature,
      stopSequences: input.options?.stopSequences,
    },
    promptHash,
    toolsHash,
  };
}

function deriveTierFromPurpose(purpose: ModelPurpose): ModelTier {
  if ((BUNDLED_MODEL_PURPOSES as readonly string[]).includes(purpose)) {
    return PURPOSE_TIER_MAP[purpose as BundledModelPurpose];
  }
  return 'default';
}

export function resetStepCounter(agent: AgentName, sessionId: string): void {
  stepCounters.set(`${agent}:${sessionId}`, 0);
}

function computePromptHash(system: string | undefined, messages: ModelMessage[]): string {
  const h = createHash('sha256');
  if (system) h.update(system);
  for (const msg of messages) {
    h.update(msg.role);
    if (typeof msg.content === 'string') {
      h.update(msg.content);
    } else {
      h.update(JSON.stringify(msg.content));
    }
  }
  return h.digest('hex').slice(0, 16);
}

function computeToolsHash(tools: ModelToolDef[]): string {
  const names = tools.map((t) => t.name).sort().join(',');
  return createHash('sha256').update(names).digest('hex').slice(0, 16);
}
