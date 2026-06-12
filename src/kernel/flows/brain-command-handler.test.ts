import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { setupBrainCommandHandler } from './brain-command-handler.js';
import type { IpcChannel } from '../ipc.js';
import type { IpcMessage } from '../types.js';
import type { BrainCommand, BrainCommandResult } from '../../contracts/brain.js';
import type { AgentManager } from '../agent-manager.js';

/**
 * 15.0 机制 D：brain.command handler 分发逻辑测试。
 *
 * 用 mock IPC（捕获 send）+ 内存库 + 假 agentManager，验证 report/inspect/execute
 * 三种指令的分发、目标不存在 fail-closed、异常不抛。
 */

/** 最小 mock IPC：记录 handler，捕获 send 的结果 */
function makeMockIpc() {
  const handlers = new Map<string, (msg: IpcMessage) => void>();
  const sent: Array<{ type: string; payload: unknown; correlationId?: string }> = [];
  const ipc = {
    onMessage: (type: string, handler: (msg: IpcMessage) => void) => {
      handlers.set(type, handler);
    },
    send: (type: string, _to: string, payload: unknown, correlationId?: string) => {
      sent.push({ type, payload, correlationId });
      return true;
    },
    emit: (msg: IpcMessage) => handlers.get(msg.type)?.(msg),
  };
  return { ipc: ipc as unknown as IpcChannel, sent };
}

/** 假 agentManager：只有指定集合内的 agent 在线（status='ready'） */
function makeMockAgentManager(online: Set<string>): AgentManager {
  return {
    getAgent: (name: string) =>
      online.has(name) ? { status: 'ready', manifest: { name } } : undefined,
  } as unknown as AgentManager;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tool_calls (
      id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT, agent_name TEXT,
      tool_name TEXT, input_summary TEXT, success INTEGER, duration_ms INTEGER,
      approved_by TEXT, error_message TEXT, created_at INTEGER
    );
  `);
  return db;
}

function cmd(target: string, type: BrainCommand['type'], payload: Record<string, unknown> = {}, priority: BrainCommand['priority'] = 'normal'): BrainCommand {
  return { target, type, payload, priority };
}

describe('brain.command handler (15.0 机制 D)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    db.prepare(
      `INSERT INTO agent_tool_calls (id, session_id, task_id, agent_name, tool_name, success, approved_by, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('1', 's', 't', 'code', 'write_file', 1, 'brain', 100);
  });

  it('report：目标在线 → 返回 ready 状态', () => {
    const { ipc, sent } = makeMockIpc();
    setupBrainCommandHandler(ipc, { agentManager: makeMockAgentManager(new Set(['code'])), db });
    ipc.emit({ type: 'brain.command', payload: cmd('code', 'report'), correlationId: 'c1' } as IpcMessage);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('brain.command.result');
    const result = sent[0].payload as BrainCommandResult;
    expect(result.success).toBe(true);
    expect((result.data as { ready: boolean }).ready).toBe(true);
  });

  it('report：目标不存在 → success:false（fail-closed）', () => {
    const { ipc, sent } = makeMockIpc();
    setupBrainCommandHandler(ipc, { agentManager: makeMockAgentManager(new Set()), db });
    ipc.emit({ type: 'brain.command', payload: cmd('ghost', 'report'), correlationId: 'c2' } as IpcMessage);
    const result = sent[0].payload as BrainCommandResult;
    expect(result.success).toBe(false);
    expect(result.error).toContain('不存在');
  });

  it('inspect：返回目标 Agent 最近工具调用', () => {
    const { ipc, sent } = makeMockIpc();
    setupBrainCommandHandler(ipc, { agentManager: makeMockAgentManager(new Set(['code'])), db });
    ipc.emit({ type: 'brain.command', payload: cmd('code', 'inspect', { limit: 5 }), correlationId: 'c3' } as IpcMessage);
    const result = sent[0].payload as BrainCommandResult;
    expect(result.success).toBe(true);
    const data = result.data as { recentToolCalls: Array<{ tool_name: string }> };
    expect(data.recentToolCalls.length).toBe(1);
    expect(data.recentToolCalls[0].tool_name).toBe('write_file');
  });

  it('execute：返回结构化确认（acknowledged）', () => {
    const { ipc, sent } = makeMockIpc();
    setupBrainCommandHandler(ipc, { agentManager: makeMockAgentManager(new Set(['code'])), db });
    ipc.emit({ type: 'brain.command', payload: cmd('code', 'execute', { task: 'do something' }, 'high'), correlationId: 'c4' } as IpcMessage);
    const result = sent[0].payload as BrainCommandResult;
    expect(result.success).toBe(true);
    expect((result.data as { acknowledged: boolean }).acknowledged).toBe(true);
  });

  it('未知 type → success:false', () => {
    const { ipc, sent } = makeMockIpc();
    setupBrainCommandHandler(ipc, { agentManager: makeMockAgentManager(new Set(['code'])), db });
    ipc.emit({ type: 'brain.command', payload: cmd('code', 'bogus' as BrainCommand['type']), correlationId: 'c5' } as IpcMessage);
    const result = sent[0].payload as BrainCommandResult;
    expect(result.success).toBe(false);
    expect(result.error).toContain('未知');
  });

  it('回复带原 correlationId（IPC 配对）', () => {
    const { ipc, sent } = makeMockIpc();
    setupBrainCommandHandler(ipc, { agentManager: makeMockAgentManager(new Set(['code'])), db });
    ipc.emit({ type: 'brain.command', payload: cmd('code', 'report'), correlationId: 'trace-xyz' } as IpcMessage);
    expect(sent[0].correlationId).toBe('trace-xyz');
  });

  it('inspect scope=audit → 运行 Auditor 5 维扫描，返回报告（D→C 闭环）', () => {
    const { ipc, sent } = makeMockIpc();
    setupBrainCommandHandler(ipc, { agentManager: makeMockAgentManager(new Set()), db });
    // 造重复工具调用（触发 repeated_tool 模式）
    for (let i = 0; i < 12; i++) {
      db.prepare(
        `INSERT INTO agent_tool_calls (id, session_id, task_id, agent_name, tool_name, success, approved_by, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(`a${i}`, 's', 't', 'code', 'write_file', 1, 'auto', 1000);
    }
    ipc.emit({
      type: 'brain.command',
      payload: cmd('any', 'inspect', { scope: 'audit', since: 0, to: 100000 }),
      correlationId: 'c6',
    } as IpcMessage);
    const result = sent[0].payload as BrainCommandResult;
    expect(result.success).toBe(true);
    const audit = (result.data as { audit: { findings: { patterns: Array<{ subject: string }> }; riskScore: number } }).audit;
    expect(audit.findings.patterns.length).toBeGreaterThanOrEqual(1);
    expect(audit.findings.patterns[0].subject).toBe('write_file');
    expect(audit.riskScore).toBeGreaterThan(0);
  });
});
