import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './session-manager.js';
import type { PendingRequest } from './session-manager.js';
import { MemoryRuntime } from '../memory/runtime.js';
import type { AppConfig } from '../config/schema.js';
import { initDb, closeDb } from '../memory/index.js';
import { getTimeline } from '../memory/message-blocks-repo.js';
import {
  getOrCreateBlockCollector,
  disposeBlockCollector,
  _clearBlockCollectorsForTest,
} from './block-collector.js';
import { initEventBus } from './event-bus.js';

/**
 * SessionManager GC 行为测试 —— 15.0 R2-4 D1 簇安全网。
 *
 * 钉死 runGc 回收过期 session 时调用 onSessionGc 回调（core-service 接线到
 * PermissionCoordinator.clearSessionMode），防止 per-session permission mode 无界增长。
 */
function makeSessionManager(onSessionGc?: (sid: string) => void): SessionManager {
  const memoryRuntime = new MemoryRuntime({} as AppConfig['memory']);
  return new SessionManager({
    memoryRuntime,
    skillLoader: null,
    evolutionEngine: null,
    // runGc 路径不读 config 字段，最小构造即可
    config: {} as AppConfig,
    onSessionGc,
  });
}

describe('SessionManager.runGc → onSessionGc 回调（15.0 R2-4 D1）', () => {
  it('GC 回收过期 session 时，对每个被回收的 session 触发 onSessionGc', () => {
    const cleared: string[] = [];
    const sm = makeSessionManager((sid) => cleared.push(sid));
    sm.touchSession('s-active-1');
    sm.touchSession('s-active-2');
    // maxInactiveMs=-1：now - lastActive = 0 > -1 → 全部过期（无 active pending 时被回收）
    const result = sm.runGc(-1);
    expect(result.cleaned).toBe(2);
    expect(cleared.sort()).toEqual(['s-active-1', 's-active-2']);
  });

  it('无 onSessionGc 回调时 runGc 仍正常工作（向后兼容）', () => {
    const sm = makeSessionManager(); // 不传 onSessionGc
    sm.touchSession('s1');
    const result = sm.runGc(-1);
    expect(result.cleaned).toBe(1);
  });

  it('未过期的 session 不被回收，回调不触发', () => {
    const cleared: string[] = [];
    const sm = makeSessionManager((sid) => cleared.push(sid));
    sm.touchSession('s1');
    // maxInactiveMs 极大值：刚 touch 的 session 未过期
    const result = sm.runGc(Number.MAX_SAFE_INTEGER);
    expect(result.cleaned).toBe(0);
    expect(cleared).toEqual([]);
  });
});

/**
 * persistInlineBlocks → message_blocks 落库链路（doc 22）。
 *
 * 这是 daemon/委派/内置 agent **三路共用的 turn 终态落库漏斗**：complete() / fail() / handoff
 * 终态都汇聚到 persistInlineBlocks（dispose 本轮 collector → buildBlocks → persistAssistantTurn）。
 * 该胶水链路（key 对齐 + dispose + 落库）此前零集成测试——存储层（message-blocks-repo.test）
 * 与 collector 本身（block-collector.test）各有单测，但「pending 的 key 是否真命中 collector」
 * 这条胶水从未被压过。本组用真实 DB + 真实 SessionManager 实跑，钉死：
 *   1. 委派/daemon key（delegationTaskId）命中 collector → tool/thinking/text 全落库
 *   2. 内置 agent key（taskId）命中 collector → tool 落库
 *   3. key 错配 → dispose 返回 undefined → 静默降级单 text block（tool 丢失！）—— 钉死不变量
 *   4. 无 collector → 降级单 text block 保气泡
 */
describe('SessionManager.persistInlineBlocks → message_blocks 落库（doc 22 三路公共漏斗）', () => {
  let dir: string;
  let sm: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'berry-persist-inline-'));
    initDb(join(dir, 'test.db'));
    initEventBus(); // BlockCollector.onToolStart 等的 defaultEmit 走全局 EventBus
    _clearBlockCollectorsForTest();
    sm = new SessionManager({
      memoryRuntime: new MemoryRuntime({} as AppConfig['memory']),
      skillLoader: null,
      evolutionEngine: null,
      config: {} as AppConfig,
    });
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 构造最小 pending（resolve noop；persistInlineBlocks 路径不触发 resolve） */
  const makePending = (overrides: Partial<PendingRequest> & { sessionId: string }): PendingRequest => ({
    userMessage: 'hi',
    resolve: () => {},
    ...overrides,
  });

  it('委派/daemon key 对齐（delegationTaskId = collector key）→ thinking/tool/text 全部落库 + collector dispose', () => {
    const taskId = 'deleg-task-1';
    // 模拟 daemon/委派 handler：建 collector（key=taskId）并累积 tool + text + thinking
    const collector = getOrCreateBlockCollector(taskId, 's1', 'corr-1');
    collector.onToolStart({ callId: 'c1', toolName: 'shell', input: { cmd: 'ls' } });
    collector.onToolComplete({ callId: 'c1', output: 'a\nb', success: true });
    collector.onTextDelta('正文内容');

    // daemon/委派：pending.delegationTaskId = taskId（派发时赋值）== collector key
    const pending = makePending({
      sessionId: 's1',
      delegationTaskId: taskId,
      reasoning: '先分析需求',
      draftResponse: '正文内容',
    });
    sm.persistInlineBlocks(pending, '正文内容');

    const tl = getTimeline('s1');
    expect(tl).toHaveLength(1);
    // buildBlocks 顺序：thinking → tool → text
    expect(tl[0].blocks.map((b) => b.type)).toEqual(['thinking', 'tool', 'text']);
    const tool = tl[0].blocks.find((b) => b.type === 'tool');
    expect(tool?.type === 'tool' && tool.name === 'shell' && tool.state === 'completed').toBe(true);
    // 落库后 collector 已 dispose（registry 释放）
    expect(disposeBlockCollector(taskId)).toBeUndefined();
  });

  it('内置 agent key 对齐（taskId = collector key，无 delegationTaskId）→ tool 落库', () => {
    const taskId = 'builtin-task-1';
    const collector = getOrCreateBlockCollector(taskId, 's2', undefined);
    collector.onToolStart({ callId: 'c1', toolName: 'fs_read', input: { path: '/a' } });
    collector.onToolComplete({ callId: 'c1', output: 'data', success: true });

    // 内置 agent：pending.taskId = collector key，无 delegationTaskId（key = delegationTaskId ?? taskId）
    const pending = makePending({ sessionId: 's2', taskId, draftResponse: '结果' });
    sm.persistInlineBlocks(pending, '结果');

    const tl = getTimeline('s2');
    expect(tl).toHaveLength(1);
    expect(tl[0].blocks.some((b) => b.type === 'tool' && b.name === 'fs_read')).toBe(true);
  });

  it('key 错配（delegationTaskId ≠ collector key）→ 静默降级单 text block，tool 丢失（钉死不变量）', () => {
    // collector 用 key-A 建，pending 却用 key-B —— 模拟 key 对齐 bug
    const collectorKey = 'key-A';
    const collector = getOrCreateBlockCollector(collectorKey, 's3', undefined);
    collector.onToolStart({ callId: 'c1', toolName: 'shell', input: {} });
    collector.onToolComplete({ callId: 'c1', output: 'out', success: true });

    const pending = makePending({ sessionId: 's3', delegationTaskId: 'key-B', draftResponse: '正文' });
    sm.persistInlineBlocks(pending, '正文');

    const tl = getTimeline('s3');
    expect(tl).toHaveLength(1);
    // dispose('key-B') 找不到 collector → blocks 降级为单 text block，tool block 丢失
    expect(tl[0].blocks.map((b) => b.type)).toEqual(['text']);
    expect(tl[0].blocks.some((b) => b.type === 'tool')).toBe(false);
    // collector 残留在 registry（泄漏）—— 正是 key 对齐为何是硬不变量
    expect(disposeBlockCollector(collectorKey)).toBeDefined();
  });

  it('无 collector（无 telemetry 的 turn）→ 降级单 text block 保气泡（消灭双轨制后唯一真相源兜底）', () => {
    const pending = makePending({
      sessionId: 's4',
      delegationTaskId: 'no-collector-task',
      draftResponse: '纯文本回复',
    });
    sm.persistInlineBlocks(pending, '纯文本回复');

    const tl = getTimeline('s4');
    expect(tl).toHaveLength(1);
    expect(tl[0].blocks.map((b) => b.type)).toEqual(['text']);
  });

  it('失败路径（contentOverride 含错误标签）→ text block 落错误标签，刷新可见', () => {
    const taskId = 'fail-task-1';
    const collector = getOrCreateBlockCollector(taskId, 's5', undefined);
    collector.onTextDelta('部分回复');
    const pending = makePending({ sessionId: 's5', delegationTaskId: taskId, draftResponse: '部分回复' });

    // 失败兜底：persistContent = 部分内容 + 错误标签。timeline 模型（block-collector 重构）下 buildBlocks
    // 用 collector 的 timeline text（onTextDelta 累积 '部分回复'），persistContent 的附加错误标签不注入
    // （draftResponse 仅在无 timeline text 时兜底）。timeline 是流式事实源。
    sm.persistInlineBlocks(pending, '部分回复\n\n*[回复中断，内容可能不完整]*');

    const tl = getTimeline('s5');
    expect(tl).toHaveLength(1);
    const text = tl[0].blocks.find((b) => b.type === 'text');
    expect((text as { text: string } | undefined)?.text).toContain('回复中断'); // 失败标签落库（persistContent 覆盖 timeline text，刷新可见）
  });
});
