import { describe, it, expect, beforeEach } from 'vitest';
import { compileRequest, resetStepCounter } from './compiler.js';

describe('compileRequest', () => {
  beforeEach(() => {
    resetStepCounter('conversation', 'ses_1');
  });

  it('生成完整的 ModelRequest 结构', () => {
    const req = compileRequest({
      agent: 'conversation',
      purpose: 'conversation',
      sessionId: 'ses_1',
      system: '你是 Berry',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'read_file', description: '读取文件', inputSchema: {} }],
    });

    expect(req.id).toMatch(/^req_/);
    expect(req.agent).toBe('conversation');
    expect(req.purpose).toBe('conversation');
    expect(req.mode).toBe('live');
    expect(req.backend).toBe('anthropic');
    expect(req.apiKind).toBe('standard');
    expect(req.sessionId).toBe('ses_1');
    expect(req.correlationId).toMatch(/^cor_/);
    expect(req.stepIndex).toBe(0);
    expect(req.system).toBe('你是 Berry');
    expect(req.messages).toHaveLength(1);
    expect(req.tools).toHaveLength(1);
    expect(req.promptHash).toHaveLength(16);
    expect(req.toolsHash).toHaveLength(16);
  });

  it('stepIndex 在同 agent+session 内递增', () => {
    const req1 = compileRequest({
      agent: 'conversation',
      purpose: 'conversation',
      sessionId: 'ses_1',
      messages: [{ role: 'user', content: 'a' }],
    });
    const req2 = compileRequest({
      agent: 'conversation',
      purpose: 'conversation',
      sessionId: 'ses_1',
      messages: [{ role: 'user', content: 'b' }],
    });

    expect(req1.stepIndex).toBe(0);
    expect(req2.stepIndex).toBe(1);
  });

  it('不同 session 的 stepIndex 独立', () => {
    const req1 = compileRequest({
      agent: 'conversation',
      purpose: 'conversation',
      sessionId: 'ses_1',
      messages: [{ role: 'user', content: 'a' }],
    });
    const req2 = compileRequest({
      agent: 'conversation',
      purpose: 'conversation',
      sessionId: 'ses_2',
      messages: [{ role: 'user', content: 'b' }],
    });

    expect(req1.stepIndex).toBe(0);
    expect(req2.stepIndex).toBe(0);
  });

  it('promptHash 对相同输入稳定', () => {
    const make = () => compileRequest({
      agent: 'brain',
      purpose: 'brain_review',
      sessionId: 'ses_1',
      system: 'review this',
      messages: [{ role: 'user', content: 'check' }],
    });

    const req1 = make();
    resetStepCounter('brain', 'ses_1');
    const req2 = make();

    expect(req1.promptHash).toBe(req2.promptHash);
  });

  it('promptHash 对不同输入不同', () => {
    const req1 = compileRequest({
      agent: 'conversation',
      purpose: 'conversation',
      sessionId: 'ses_1',
      system: 'sys a',
      messages: [{ role: 'user', content: 'hello' }],
    });
    resetStepCounter('conversation', 'ses_1');
    const req2 = compileRequest({
      agent: 'conversation',
      purpose: 'conversation',
      sessionId: 'ses_1',
      system: 'sys b',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(req1.promptHash).not.toBe(req2.promptHash);
  });

  it('没有 tools 时 toolsHash 为 undefined', () => {
    const req = compileRequest({
      agent: 'conversation',
      purpose: 'conversation',
      sessionId: 'ses_1',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(req.toolsHash).toBeUndefined();
  });

  it('允许自定义 mode 和 backend', () => {
    const req = compileRequest({
      agent: 'code',
      purpose: 'code_task',
      sessionId: 'ses_1',
      messages: [{ role: 'user', content: 'fix bug' }],
      mode: 'mock',
      backend: 'test',
      apiKind: 'claude_agent_sdk',
    });

    expect(req.mode).toBe('mock');
    expect(req.backend).toBe('test');
    expect(req.apiKind).toBe('claude_agent_sdk');
  });
});
