/**
 * L4 admin 单元测试——两只读工具的工具层行为：
 * plugins_list 文本化呈现（四态行 + 计数行 + source）与 events_query 参数翻译
 * （ISO 8601 转毫秒 / cursor 形状校验 / flushFirst 恒置 true / data 摘要截断）。
 *
 * 服务面用本件消费面接口（PluginsListFace/SessionsQueryFace）的测试替身——
 * 服务面形状由宿主装配保证，本文件只锁工具层翻译与呈现语义。
 */

import { describe, expect, it } from 'vitest';
import { AppError, TOOL_ARGUMENTS_INVALID } from '../contracts/errors.js';
import type { EventQueryOptions, EventQueryResult } from '../contracts/events.js';
import { createEventsQueryTool, createPluginsListTool } from './plugin.js';
import type { PluginRowView, PluginsListFace, SessionsQueryFace } from './plugin.js';
import type { ToolCtx } from '../contracts/tools.js';

/** 最小工具执行上下文（execute(args, ctx) 第二参——本件两工具不消费 ctx 内容） */
const CTX: ToolCtx = { toolCallId: 'tc' };

/** 取纯文本结果（本件两工具均单文本块） */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');
  return result.content[0]!.text ?? '';
}

/** 捕获 queryEvents 实参的替身服务（返回值可脚本） */
function recordingSessions(responds: EventQueryResult) {
  const calls: EventQueryOptions[] = [];
  const sessions: SessionsQueryFace = {
    async queryEvents(opts) {
      calls.push(opts);
      return responds;
    },
  };
  return { sessions, calls };
}

describe('plugins_list（装载态一览的文本化呈现——不造第二数据源）', () => {
  const plugins: PluginsListFace = {
    list: () =>
      [
        { id: 'chat', status: 'activated', name: 'chat', applyMs: 3, source: 'builtin' },
        { id: 'bad', status: 'failed', code: 'PLUGIN_APPLY_FAILED', message: '炸了', source: 'local' },
        { id: 'off', status: 'skipped', reason: 'disabled', source: 'npm' },
        { id: 'ghost', status: 'planned', source: 'git' },
      ] satisfies PluginRowView[],
  };

  it('四态行 + 计数行 + source 呈现；空树有专属提示', async () => {
    const tool = createPluginsListTool(plugins);
    const text = textOf(await tool.execute({}, CTX));
    // 计数行（与 environment 第五件同款口径）
    expect(text).toContain('共 4 行：activated 1 · failed 1 · skipped 1');
    // 四态行各带 id 与 source
    expect(text).toContain('✓ chat（builtin · chat · apply 3ms）');
    expect(text).toContain('✖ bad（local）：PLUGIN_APPLY_FAILED 炸了');
    expect(text).toContain('· off（npm）跳过：disabled');
    expect(text).toContain('○ ghost（git）planned');
    // 无参数工具：schema 是空对象
    expect(tool.parameters).toBeDefined();
    expect(tool.effect).toBe('read');
  });

  it('组合树无行（--no-plugins 安全模式）：清单为空提示', async () => {
    const empty: PluginsListFace = { list: () => [] };
    const text = textOf(await createPluginsListTool(empty).execute({}, CTX));
    expect(text).toContain('组合树无插件行');
  });
});

describe('events_query（单原语的工具层壳：翻译/校验/呈现）', () => {
  it('ISO 8601 转毫秒 + flushFirst 恒置 true（不入模型面参数语义）', async () => {
    const { sessions, calls } = recordingSessions({ rows: [], truncated: false });
    await createEventsQueryTool(sessions).execute(
      { since: '2026-08-27T00:00:00Z', until: '2026-08-27T23:59:59Z' },
      CTX,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sinceMs).toBe(Date.parse('2026-08-27T00:00:00Z'));
    expect(calls[0]!.untilMs).toBe(Date.parse('2026-08-27T23:59:59Z'));
    expect(calls[0]!.flushFirst).toBe(true); // 恒置 true——模型面精确性优先
  });

  it('非法 ISO 时间：TOOL_ARGUMENTS_INVALID 响亮拒绝（带示例）', async () => {
    const { sessions } = recordingSessions({ rows: [], truncated: false });
    try {
      await createEventsQueryTool(sessions).execute({ since: '不是时间' }, CTX);
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(TOOL_ARGUMENTS_INVALID);
      expect((err as AppError).message).toContain('ISO 8601');
    }
  });

  it('cursor 形状校验：坏形状响亮拒绝；合法三键原样透传', async () => {
    const { sessions, calls } = recordingSessions({ rows: [], truncated: false });
    const tool = createEventsQueryTool(sessions);
    try {
      await tool.execute({ cursor: { time: 'x', sessionId: 's', seq: 1 } }, CTX);
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(TOOL_ARGUMENTS_INVALID);
    }
    await tool.execute({ cursor: { time: 123, sessionId: 's-1', seq: 7 } }, CTX);
    expect(calls[0]!.cursor).toEqual({ time: 123, sessionId: 's-1', seq: 7 });
  });

  it('行呈现：ISO 时间 + 会话短 id + 类型 + data 摘要（超 300 字符截断标注全文长度）', async () => {
    const long = { blob: 'x'.repeat(500) };
    const t0 = Date.parse('2026-08-27T00:00:00Z');
    const { sessions } = recordingSessions({
      rows: [
        { sessionId: 'abcdefgh-1234', seq: 9, type: 'user/message', time: t0, data: { content: 'hi' } },
        { sessionId: 'zzzzzzzz-9999', seq: 1, type: 'llm/usage', time: t0 + 1, data: long },
      ],
      truncated: true,
      nextCursor: { time: t0, sessionId: 'abcdefgh-1234', seq: 9 },
    });
    const text = textOf(await createEventsQueryTool(sessions).execute({}, CTX));
    // 行格式四段
    expect(text).toContain('2026-08-27T00:00:00.000Z  abcdefgh  user/message  {"content":"hi"}');
    // 摘要截断：300 字符 + 全文长度标注
    expect(text).toContain('已截断，全文 ');
    expect(text).not.toContain('x'.repeat(400));
    // nextCursor JSON 行 + truncated 标注 + 迟滞说明尾行
    expect(text).toContain('nextCursor 回传翻页');
    expect(text).toContain('[truncated]');
    expect(text).toContain('[迟滞说明]');
  });

  it('空集提示：过滤条件拼写核对指引（不误报错误）', async () => {
    const { sessions } = recordingSessions({ rows: [], truncated: false });
    const text = textOf(await createEventsQueryTool(sessions).execute({ types: ['gone/word'] }, CTX));
    expect(text).toContain('无匹配事件');
  });
});
