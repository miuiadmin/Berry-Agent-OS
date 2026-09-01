/**
 * ChatView 组件测试（P1-3 SPA 测试轨——投影→组件数据流回归锁）。
 *
 * 锁 CR-2 半程态合并 + CR-13 累积快照渲染两条渲染模型规则与呈现面：
 * - 投影展平：user 行 / assistant 行 / 工具卡（toolResult 同键回并）；
 * - pending 卡（result 未到）与孤儿结果独立成卡（异源恢复防御）；
 * - 活体尾部：流式文本投影尾部同文去重、未入投影的工具卡；
 * - errorMessage 独立红行（基建大扫 #42）；
 * - inline 审批卡（三态按钮 gated on suggestedEntry）与 rewind 转录行。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from './chat-view';
import type { LiveState } from './app';
import type { PendingApproval, ProjectedMessage, RewindRow } from './types';

afterEach(cleanup);

/** 造 assistant 文本消息（块数组形态——pi-ai 线格式） */
function assistantText(seq: number, text: string): ProjectedMessage {
  return { type: 'assistant', seq, content: [{ type: 'text', text }], toolCalls: [] };
}

/** 造带一次工具调用的 assistant 消息 */
function assistantWithCall(seq: number, callId: string, toolName: string): ProjectedMessage {
  return {
    type: 'assistant',
    seq,
    content: [{ type: 'text', text: '调工具' }],
    toolCalls: [{ type: 'toolCall', toolCallId: callId, toolName, arguments: '{"path":"a.ts"}' }],
  };
}

/** 空活态（live 缺省） */
function noLive(): LiveState | null {
  return null;
}

/** 视图属性缺省值（单测逐案覆写） */
function baseProps() {
  return { live: noLive(), approvals: [] as PendingApproval[], rewinds: [] as RewindRow[], onDecide: vi.fn() };
}

describe('ChatView 投影展平（渲染序即消息序）', () => {
  it('user（字符串 content）与 assistant（块数组 content）双形态渲染', () => {
    const messages: ProjectedMessage[] = [{ type: 'user', seq: 1, content: '你好' }, assistantText(2, '纯文本回答')];
    render(<ChatView messages={messages} {...baseProps()} />);
    expect(screen.getByText('你好')).toBeTruthy();
    expect(screen.getByText('纯文本回答')).toBeTruthy();
  });

  it('空会话空态文案（零消息 + 零审批才现）', () => {
    render(<ChatView messages={[]} {...baseProps()} />);
    expect(screen.getByText('空会话——发送第一条消息')).toBeTruthy();
  });

  it('errorMessage 在场即独立红行（content 空的失败 run 不再屏上无声）', () => {
    const messages: ProjectedMessage[] = [
      { type: 'assistant', seq: 1, content: [], toolCalls: [], errorMessage: '模型超限' },
    ];
    render(<ChatView messages={messages} {...baseProps()} />);
    expect(screen.getByText('✖ 模型超限')).toBeTruthy();
  });
});

describe('ChatView 工具卡三态（CR-2 半程态合并）', () => {
  it('投影无配对 result 的 toolCall = pending 卡（⏳ 执行中…）', () => {
    const messages = [assistantWithCall(2, 'call-1', 'fs_read')];
    render(<ChatView messages={messages} {...baseProps()} />);
    expect(screen.getByText('fs_read')).toBeTruthy();
    expect(screen.getByText('执行中…')).toBeTruthy();
    expect(screen.getByText('⏳')).toBeTruthy();
  });

  it('toolResult 同键回并：✓ 完成 + 输出预览入卡', () => {
    const messages: ProjectedMessage[] = [
      assistantWithCall(2, 'call-1', 'fs_read'),
      { type: 'toolResult', seq: 3, toolCallId: 'call-1', toolName: 'fs_read', output: '文件内容甲', isError: false },
    ];
    render(<ChatView messages={messages} {...baseProps()} />);
    expect(screen.getByText('✓')).toBeTruthy();
    expect(screen.getByText('完成')).toBeTruthy();
    expect(screen.getByText('文件内容甲')).toBeTruthy();
  });

  it('isError 结果卡：✗ 出错 + 输出红字', () => {
    const messages: ProjectedMessage[] = [
      assistantWithCall(2, 'call-1', 'bash'),
      { type: 'toolResult', seq: 3, toolCallId: 'call-1', toolName: 'bash', output: '退出码 1', isError: true },
    ];
    render(<ChatView messages={messages} {...baseProps()} />);
    expect(screen.getByText('✗')).toBeTruthy();
    expect(screen.getByText('出错')).toBeTruthy();
    expect(screen.getByText('退出码 1')).toBeTruthy();
  });

  it('孤儿 toolResult（前置 call 不在投影）独立成卡——异源恢复会话防御', () => {
    const messages: ProjectedMessage[] = [
      { type: 'toolResult', seq: 9, toolCallId: 'ghost', toolName: 'web_fetch', output: '旧输出', isError: false },
    ];
    render(<ChatView messages={messages} {...baseProps()} />);
    expect(screen.getByText('web_fetch')).toBeTruthy();
    expect(screen.getByText('✓')).toBeTruthy();
    expect(screen.getByText('旧输出')).toBeTruthy();
  });

  it('活体帧补窗口期：live.tools 的卡（未入投影）按帧状态渲染', () => {
    const live: LiveState = {
      streamText: '',
      streamDone: false,
      tools: new Map([
        ['live-a', { name: 'bash', argsText: 'ls', done: false }],
        ['live-b', { name: 'fs_write', output: '写失败', isError: true, done: true }],
      ]),
    };
    render(<ChatView messages={[]} {...baseProps()} live={live} />);
    expect(screen.getByText('bash')).toBeTruthy();
    expect(screen.getByText('执行中…')).toBeTruthy();
    expect(screen.getByText('fs_write')).toBeTruthy();
    expect(screen.getByText('出错')).toBeTruthy();
  });
});

describe('ChatView 活体流式文本（CR-13 累积快照）', () => {
  it('streamText 未入投影 → 流式行呈现（尾部光标 ◍）', () => {
    const live: LiveState = { streamText: '流式中回答', streamDone: false, tools: new Map() };
    render(<ChatView messages={[]} {...baseProps()} live={live} />);
    expect(screen.getByText(/流式中回答/)).toBeTruthy();
  });

  it('投影尾部同文去重：turn 落账与 message_end 镜像双时序都不双渲染', () => {
    const messages = [assistantText(2, '同文回答')];
    const live: LiveState = { streamText: '同文回答', streamDone: true, tools: new Map() };
    render(<ChatView messages={messages} {...baseProps()} live={live} />);
    expect(screen.queryAllByText('同文回答')).toHaveLength(1);
  });
});

describe('ChatView 审批卡与 rewind 转录行（刀三活体 only 面）', () => {
  it('审批卡：待审批 + 摘要 + 允许/拒绝两键；suggestedEntry 在场才现「始终允许」', () => {
    const approvals: PendingApproval[] = [
      { approvalId: 'ap1', sessionId: 's1', summary: '写入 /tmp/x' },
      {
        approvalId: 'ap2',
        sessionId: 's1',
        summary: '联网取数',
        suggestedEntry: { tool: 'web_fetch', pattern: 'example.com/*' },
      },
    ];
    const onDecide = vi.fn();
    render(<ChatView messages={[]} approvals={approvals} rewinds={[]} live={null} onDecide={onDecide} />);
    expect(screen.getAllByText('待审批')).toHaveLength(2);
    expect(screen.getByText('写入 /tmp/x')).toBeTruthy();
    expect(screen.getAllByText('始终允许')).toHaveLength(1); // 仅 ap2（草案在场）——ap1 无草案不现
    expect(screen.getByText(/web_fetch · example\.com\/\*/)).toBeTruthy(); // 草案行披露
    fireEvent.click(screen.getAllByText('允许')[0]!);
    expect(onDecide).toHaveBeenCalledWith('ap1', 'approve');
  });

  it('rewind 转录行：⏪ 已回退至快照短 id + 新会话 + 文件数', () => {
    const rewinds: RewindRow[] = [{ sessionId: 's1', id: 'snap-1234567890', newSessionId: 'new-0987654321', files: 3 }];
    render(<ChatView messages={[]} approvals={[]} rewinds={rewinds} live={null} onDecide={vi.fn()} />);
    expect(screen.getByText(/已回退至 snap-123/)).toBeTruthy(); // slice(0,8) = 'snap-123'
    expect(screen.getByText(/新会话 new-0987/)).toBeTruthy();
    expect(screen.getByText(/3 个文件已恢复/)).toBeTruthy();
  });
});
