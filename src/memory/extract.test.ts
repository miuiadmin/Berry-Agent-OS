/**
 * L3 memory 单元测试（提取即时路——纠正检测零 LLM）——触发词命中/保守不误杀、
 * user/message 载荷解析、session/event 订阅接线（真 ctx + 真库全栈，无 mock）。
 */

import { describe, expect, it } from 'vitest';
import { createContext } from '../context/index.js';
import { createLogger } from '../context/logger.js';
import { openStore } from '../persist/index.js';
import { MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION } from './schema.js';
import { MemoryStore } from './store.js';
import { attachCorrectionExtractor, detectCorrection, userTextFromContent } from './extract.js';

/** 真 :memory: 记忆库 */
function newStore(): MemoryStore {
  return new MemoryStore(
    openStore({ path: ':memory:', migrations: [MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION] }).connection,
  );
}

/** 静默 logger 根作用域（拦截用例走 warn/error 通道时收行断言） */
function captureRoot() {
  const lines: string[] = [];
  const sink = (line: string) => lines.push(line);
  const ctx = createContext({ logger: createLogger({ module: 'test', level: 'debug', sink }) });
  return { ctx, lines };
}

/** 构造 session/event 信封载荷（dsh-11：{ sessionId, event }） */
function userEvent(sessionId: string, seq: number, content: unknown) {
  return { sessionId, event: { type: 'user/message', seq, time: 1, data: { content } } };
}

describe('detectCorrection（触发词表——保守取向）', () => {
  it('中文纠正式命中', () => {
    expect(detectCorrection('不对，应该用 pnpm')).toBeDefined();
    expect(detectCorrection('我说的是 src 目录不是 test')).toBeDefined();
    expect(detectCorrection('别再生成多余的测试文件了')).toBeDefined();
    expect(detectCorrection('你搞错了，这是规范化不是迁移')).toBeDefined();
    expect(detectCorrection('重新写一版，这次注意缩进')).toBeDefined();
  });

  it('英文纠正式命中', () => {
    expect(detectCorrection('no, I meant the config file')).toBeDefined();
    expect(detectCorrection("that's not what I asked for")).toBeDefined();
    expect(detectCorrection('stop using npm here, wrong tool, use pnpm instead')).toBeDefined();
  });

  it('普通叙述不误杀（保守判据）', () => {
    expect(detectCorrection('帮我看下这个文件的实现')).toBeUndefined();
    expect(detectCorrection('这里逻辑可能不对劲，帮我确认下')).toBeUndefined(); // 描述非纠正
    expect(detectCorrection('我已经做完了这个任务')).toBeUndefined(); // 「做了」非「做错了」
    expect(detectCorrection('')).toBeUndefined();
  });

  it('超长纠正摘录截断（summary 比较面封顶）', () => {
    const long = '不对，'.repeat(60);
    const excerpt = detectCorrection(long);
    expect(excerpt).toBeDefined();
    expect(excerpt!.length).toBeLessThanOrEqual(81); // 80 上限 + 省略号
  });
});

describe('userTextFromContent（user/message 载荷解析）', () => {
  it('string 直取；内容块数组拼 text 部分跳非文本块；异形回空串', () => {
    expect(userTextFromContent('纯文本')).toBe('纯文本');
    expect(
      userTextFromContent([
        { type: 'text', text: '第一段' },
        { type: 'image', source: { data: 'x' } } as unknown,
        { type: 'text', text: '第二段' },
      ]),
    ).toBe('第一段\n第二段');
    expect(userTextFromContent(42)).toBe('');
    expect(userTextFromContent(undefined)).toBe('');
  });
});

describe('attachCorrectionExtractor（session/event 订阅全栈）', () => {
  it('纠正用户消息 → correction 条目入库（溯源 sessionId+seq）；重复纠正走合并增强', () => {
    const { ctx } = captureRoot();
    const store = newStore();
    attachCorrectionExtractor(ctx, { store });

    ctx.emit('session/event', userEvent('sess-1', 3, '不对，这个仓库要用 pnpm'));
    const records = store.list(['global']);
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe('correction');
    expect(records[0]!.summary).toContain('纠正：');
    expect(records[0]!.sourceRefs).toEqual([{ sessionId: 'sess-1', seq: 3 }]);

    // 同一纠正再来一次（另一会话）→ 合并管线接管：证据 +1，不新增条目
    ctx.emit('session/event', userEvent('sess-2', 0, '不对，这个仓库要用 pnpm'));
    expect(store.list(['global'])).toHaveLength(1);
    expect(store.list(['global'])[0]!.evidenceCount).toBe(2);
  });

  it('非 user/message 事件与非纠正消息零动作', () => {
    const { ctx } = captureRoot();
    const store = newStore();
    attachCorrectionExtractor(ctx, { store });
    ctx.emit('session/event', { sessionId: 's', event: { type: 'assistant/message', seq: 1, time: 1, data: {} } });
    ctx.emit('session/event', userEvent('s', 2, '帮我看下这个文件'));
    expect(store.list(['global'])).toHaveLength(0);
  });

  it('纠正消息含密钥 → 写前扫描拦截不入库，log-only 诊断不泄内容', () => {
    const { ctx, lines } = captureRoot();
    const store = newStore();
    attachCorrectionExtractor(ctx, { store });
    const secret = '不对，用这个 key sk-ant-' + 'q'.repeat(30);
    ctx.emit('session/event', userEvent('s', 0, secret));
    expect(store.list(['global'])).toHaveLength(0);
    // 诊断只带模式名——疑似密钥原文不得出现在任何日志行
    const warnLine = lines.find((l) => l.includes('拦截'));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain('anthropic-api-key');
    expect(lines.join('\n')).not.toContain('q'.repeat(30));
  });

  it('退订器生效：dispose 后不再提取', async () => {
    const { ctx } = captureRoot();
    const store = newStore();
    const off = attachCorrectionExtractor(ctx, { store });
    off();
    ctx.emit('session/event', userEvent('s', 0, '不对，要用 pnpm'));
    expect(store.list(['global'])).toHaveLength(0);
  });

  it('ownerKey 覆盖：项目归属提取（装配层按场景注入）', () => {
    const { ctx } = captureRoot();
    const store = newStore();
    attachCorrectionExtractor(ctx, { store, ownerKey: 'project:abc' });
    ctx.emit('session/event', userEvent('s', 0, '不对，要用 pnpm'));
    expect(store.list(['project:abc'])).toHaveLength(1);
    expect(store.list(['global'])).toHaveLength(0);
  });
});
