import { describe, it, expect } from 'vitest';
import {
  AgentNameSchema,
  AgentTaskSchema,
  TaskEventSchema,
  TaskTypeSchema,
  TaskStatusSchema,
  BUNDLED_AGENT_NAMES,
  BUNDLED_TASK_TYPES,
} from './agents.js';
import {
  ModelRequestSchema,
  ModelResponseSchema,
  ModelPurposeSchema,
  ModelModeSchema,
  BUNDLED_MODEL_PURPOSES,
  MODEL_MODES,
} from './model.js';
import {
  ApprovalRequestSchema,
  PermissionTokenSchema,
  PermissionBindingSchema,
  ApprovalKindSchema,
  RiskLevelSchema,
  APPROVAL_KINDS,
  RISK_LEVELS,
} from './approvals.js';

describe('contracts/agents', () => {
  it('validates AgentName as any non-empty string', () => {
    expect(AgentNameSchema.parse('brain')).toBe('brain');
    expect(AgentNameSchema.parse('plugin-builder')).toBe('plugin-builder');
    expect(AgentNameSchema.parse('custom-agent')).toBe('custom-agent');
    expect(() => AgentNameSchema.parse('')).toThrow();
  });

  it('bundled agent names are defined', () => {
    expect(BUNDLED_AGENT_NAMES).toContain('brain');
    expect(BUNDLED_AGENT_NAMES).toContain('conversation');
    expect(BUNDLED_AGENT_NAMES).toContain('code');
    expect(BUNDLED_AGENT_NAMES.length).toBe(7);
  });

  it('validates TaskType as any non-empty string and TaskStatus as enum', () => {
    expect(TaskTypeSchema.parse('conversation_turn')).toBe('conversation_turn');
    expect(TaskTypeSchema.parse('custom_task')).toBe('custom_task');
    expect(TaskStatusSchema.parse('running')).toBe('running');
    expect(() => TaskTypeSchema.parse('')).toThrow();
  });

  it('validates AgentTask schema', () => {
    const task = {
      id: 'tsk_abc',
      runId: null,
      sessionId: 'ses_123',
      correlationId: 'cor_456',
      taskType: 'conversation_turn',
      requester: 'conversation',
      targetAgent: 'brain',
      foreground: true,
      priority: 0,
      inputPayload: { message: 'hi' },
      outputPayload: null,
      status: 'created',
      error: null,
      createdAt: Date.now(),
      dispatchedAt: null,
      acknowledgedAt: null,
      startedAt: null,
      finishedAt: null,
    };
    expect(AgentTaskSchema.parse(task)).toMatchObject({ id: 'tsk_abc' });
  });

  it('validates TaskEvent schema', () => {
    const event = {
      id: 'evt_001',
      taskId: 'tsk_abc',
      runId: null,
      sessionId: 'ses_123',
      source: 'brain',
      eventType: 'started',
      level: 'info',
      message: '任务开始执行',
      payload: {},
      createdAt: Date.now(),
    };
    expect(TaskEventSchema.parse(event)).toMatchObject({ id: 'evt_001' });
  });
});

describe('contracts/model', () => {
  it('validates ModelPurpose as any non-empty string', () => {
    for (const p of BUNDLED_MODEL_PURPOSES) {
      expect(ModelPurposeSchema.parse(p)).toBe(p);
    }
    expect(ModelPurposeSchema.parse('custom_purpose')).toBe('custom_purpose');
    expect(() => ModelPurposeSchema.parse('')).toThrow();
  });

  it('validates ModelMode enum', () => {
    for (const m of MODEL_MODES) {
      expect(ModelModeSchema.parse(m)).toBe(m);
    }
  });

  it('validates ModelRequest schema', () => {
    const req = {
      id: 'req_001',
      agent: 'conversation',
      purpose: 'conversation',
      mode: 'live',
      backend: 'anthropic',
      apiKind: 'standard',
      sessionId: 'ses_123',
      correlationId: 'cor_456',
      stepIndex: 0,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
      options: { maxTokens: 2048, temperature: 0.7 },
      promptHash: 'abc123',
    };
    expect(ModelRequestSchema.parse(req)).toMatchObject({ id: 'req_001' });
  });

  it('validates ModelResponse schema', () => {
    const res = {
      requestId: 'req_001',
      content: 'Hello!',
      contentBlocks: [{ type: 'text', text: 'Hello!' }],
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
      model: 'test-model',
    };
    expect(ModelResponseSchema.parse(res)).toMatchObject({ requestId: 'req_001' });
  });

  it('rejects empty purpose', () => {
    expect(() => ModelPurposeSchema.parse('')).toThrow();
  });
});

describe('contracts/approvals', () => {
  it('validates ApprovalKind and RiskLevel', () => {
    for (const k of APPROVAL_KINDS) {
      expect(ApprovalKindSchema.parse(k)).toBe(k);
    }
    for (const r of RISK_LEVELS) {
      expect(RiskLevelSchema.parse(r)).toBe(r);
    }
  });

  it('validates PermissionBinding schema', () => {
    const binding = {
      sessionId: 'ses_123',
      agentName: 'conversation',
      toolName: 'run_command',
      inputHash: 'abcdef1234567890',
      cwd: '/tmp',
    };
    expect(PermissionBindingSchema.parse(binding)).toMatchObject({ sessionId: 'ses_123' });
  });

  it('validates ApprovalRequest schema', () => {
    const req = {
      id: 'apr_001',
      runId: null,
      sessionId: 'ses_123',
      taskId: null,
      correlationId: 'cor_456',
      kind: 'tool',
      requester: 'conversation',
      riskLevel: 'medium',
      requestPayload: { toolName: 'run_command', args: 'ls' },
      bindingPayload: {
        sessionId: 'ses_123',
        agentName: 'conversation',
        toolName: 'run_command',
        inputHash: 'hash123',
      },
      status: 'pending',
      decisionSource: null,
      reason: null,
      expiresAt: Date.now() + 60000,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    expect(ApprovalRequestSchema.parse(req)).toMatchObject({ id: 'apr_001' });
  });

  it('validates PermissionToken schema', () => {
    const token = {
      id: 'ptk_001',
      approvalId: 'apr_001',
      runId: null,
      sessionId: 'ses_123',
      agentName: 'conversation',
      toolName: 'run_command',
      inputHash: 'hash123',
      cwd: null,
      bindingHash: 'bindhash',
      verdict: 'allow_once',
      oneTime: true,
      consumed: false,
      expiresAt: Date.now() + 60000,
      createdAt: Date.now(),
      consumedAt: null,
    };
    expect(PermissionTokenSchema.parse(token)).toMatchObject({ id: 'ptk_001' });
  });
});
