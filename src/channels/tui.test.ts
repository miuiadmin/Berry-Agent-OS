/**
 * L4 channels — TUI 通道 S3 多会话呈现测试（契约篇 §5.4 S3 射面验收）。
 *
 * 假终端收集渲染帧（requestRender 经 setTimeout 调度——一轮宏任务后断言），
 * 三面验收：① 互不绞屏（聚焦者事件进正文、非聚焦者只摘要行）；② repaint
 * 清屏重画（历史按会话键重画 + 旧正文不再现）；③ 在飞占位槽（切入 running
 * 条目 → 占位开、message_update 全量快照直推续流、message_end 终值落正文）。
 * 键盘交互面（Editor/提问队列）不在本文件射程。
 */

import { describe, expect, it } from 'vitest';
import type { Terminal } from '@earendil-works/pi-tui';
import type { AssistantMessage } from '../contracts/llm.js';
import type { AgentEvent } from '../agent/events.js';
import type { AgentMessage } from '../contracts/messages.js';
import { createTuiChannel } from './tui.js';
import type { ChannelHost } from './types.js';
import type { CommandRegistry } from './commands.js';

/* ---------------- 假终端与事件构造 ---------------- */

/** 假终端：逐帧收集 write 输出（start/stop/光标面 no-op——不测键盘） */
function fakeTerminal(): Terminal & { frames: string[] } {
  const frames: string[] = [];
  return {
    start() {},
    stop() {},
    drainInput: async () => undefined,
    write(data: string) {
      frames.push(data);
    },
    get columns() {
      return 100;
    },
    get rows() {
      return 30;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    frames,
  };
}

/** 空命令注册表（本文件不派发命令——输入路由不触发） */
const emptyCommands = {
  register: () => () => undefined,
  list: () => [],
} as unknown as CommandRegistry;

/** 空宿主（submit/requestQuit 不应被触达——触达即断言失败） */
const strictHost: ChannelHost = {
  submit: () => expect.unreachable('本测试不应提交消息'),
  requestQuit: () => expect.unreachable('本测试不应请求退出'),
};

/** 零用量（AssistantMessage 构造腿） */
const NO_USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };

/** assistant 消息（完整腿——start/update/end 共用形状） */
const assistantMessage = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: NO_USAGE,
  stopReason: 'stop',
  timestamp: 1,
});

/** message_update 事件（partial 全量快照语义——S3 在飞续流的载体） */
const messageUpdate = (text: string): AgentEvent => ({
  type: 'message_update',
  message: assistantMessage(text),
  streamEvent: { type: 'text_delta', contentIndex: 0, delta: text, partial: assistantMessage(text) },
});

/** user 历史消息（repaint 投影重画的载荷形状） */
const userHistory = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: 1 });

/** 刷渲染帧（requestRender 经 setTimeout 调度——宏任务一轮后帧已落） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/* ---------------- 用例 ---------------- */

describe('S3 TUI 分流呈现（互不绞屏执法面）', () => {
  it('聚焦者事件进正文；非聚焦者 agent_start/agent_end 落摘要行、message 事件不进正文', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    // 聚焦者 assistant 流式进正文
    tui.handle({ type: 'agent_start' });
    tui.handle({ type: 'message_start', message: assistantMessage('聚焦者的回答') });
    tui.handle(messageUpdate('聚焦者的回答'));
    tui.handle({ type: 'message_end', message: assistantMessage('聚焦者的回答') });
    // 非聚焦者（后台/退役统一）：agent_start/agent_end 摘要行 + message 不进正文
    tui.handleActivity('session-xxxx-background', { type: 'agent_start' });
    tui.handleActivity('session-xxxx-background', {
      type: 'message_start',
      message: assistantMessage('后台者的回答'),
    });
    tui.handleActivity('session-xxxx-background', { type: 'agent_end', status: 'completed', messages: [] });
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain('聚焦者的回答'); // 聚焦者全渲染
    expect(all).toContain('⧗ 会话 session- 后台工作中'); // 摘要行（短 id 前 8 位）
    expect(all).toContain('✓ 会话 session- 后台完成');
    expect(all).not.toContain('后台者的回答'); // 互不绞屏：后台正文不进聚焦屏
  });
});

describe('S3 repaint 清屏重画（focus 变化驱动）', () => {
  it('旧正文不再现、目标会话历史投影重画（按会话键取）', async () => {
    const terminal = fakeTerminal();
    const histories = new Map<string, AgentMessage[]>([['session-target', [userHistory('目标会话的历史问')]]]);
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      history: (sessionId) => (sessionId !== undefined ? (histories.get(sessionId) ?? []) : []),
    });
    // 聚焦者先落一答
    tui.handle({ type: 'message_start', message: assistantMessage('旧会话正文') });
    tui.handle({ type: 'message_end', message: assistantMessage('旧会话正文') });
    await flush();
    const beforeIndex = terminal.frames.length;
    // 切换：清屏重画到目标会话
    tui.repaint('session-target');
    await flush();
    const after = terminal.frames.slice(beforeIndex).join('');
    expect(after).toContain('目标会话的历史问'); // 历史投影按会话键重画
    expect(after).not.toContain('旧会话正文'); // 旧正文已被清出（差分删除不重打）
  });

  it('切入在飞条目：占位槽开 + message_update 快照直推续流 + message_end 终值落正文', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      history: () => [],
      entryStatus: (sessionId) => (sessionId === 'session-flying' ? 'running' : 'idle'),
    });
    tui.repaint('session-flying'); // 切入正在跑的条目（agent_start 已错过、状态可查）
    await flush();
    const afterRepaint = terminal.frames.join('');
    expect(afterRepaint).toContain('● 工作中'); // 状态行按 entryStatus 设定
    // 后续 message_update 的 partial 是全量快照——直推整块替换即自然续流（无需 message_start）
    tui.handle(messageUpdate('在飞会话的续流内容'));
    await flush();
    expect(terminal.frames.join('')).toContain('在飞会话的续流内容');
    tui.handle({ type: 'message_end', message: assistantMessage('在飞会话的续流内容') });
    await flush();
    expect(terminal.frames.join('')).toContain('在飞会话的续流内容'); // 终值落正文可见
  });
});
