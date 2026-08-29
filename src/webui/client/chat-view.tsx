/**
 * 对话视图——投影主列表 + run 活体尾部增量。
 *
 * CR-2 半程态合并规则（契约篇 §6.8 刀二细化）：
 * - 投影中无配对 toolResult 的 toolCall 按 **pending 卡**渲染（半程态合法
 *   展示档——assistant 已落账、工具还在跑）；
 * - display 族 tool_execution_* 帧按 **toolCallId 同键**覆盖卡片状态/输出
 *   （活体先到 = 卡片先动；投影随后到 = 真值替换）；
 * - 活体流式文本只在「投影尚未包含同文本」时渲染（assistant/message 落账
 *   时序与 turn_end 镜像之间存在窗口——按投影尾部同文比对去重，两时序都
 *   不双渲染）。
 */

import { useEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { LiveState, LiveTool } from './app';
import { previewOf } from './app';
import type { ProjectedMessage, ProjectedToolCall } from './types';
import { textOf } from './text';

/** 工具结果投影行（derive toolResult 型的窄用面） */
type ToolResultMessage = Extract<ProjectedMessage, { type: 'toolResult' }>;

/** 渲染项三族（投影展平 + 活体尾部——渲染序即消息序） */
type RenderItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'tool'; call: ProjectedToolCall; result: ToolResultMessage | undefined; liveTool: LiveTool | undefined };

/** 视图属性 */
interface ChatViewProps {
  readonly messages: readonly ProjectedMessage[];
  readonly live: LiveState | null;
}

/** 对话主视图（自动滚底——投影或活体变化即贴底） */
export function ChatView({ messages, live }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  /** 投影 → 渲染项：user 行 / assistant 文本 / 工具卡（toolResult 回并配对卡） */
  const items = useMemo<RenderItem[]>(() => {
    const results = new Map<string, ToolResultMessage>();
    for (const msg of messages) {
      if (msg.type === 'toolResult') results.set(msg.toolCallId, msg);
    }
    const out: RenderItem[] = [];
    const seenCalls = new Set<string>();
    for (const msg of messages) {
      if (msg.type === 'user') {
        const text = textOf(msg.content);
        if (text !== '') out.push({ kind: 'user', text });
      } else if (msg.type === 'assistant') {
        const text = textOf(msg.content);
        if (text !== '') out.push({ kind: 'assistant', text, streaming: false });
        for (const call of msg.toolCalls) {
          seenCalls.add(call.toolCallId);
          // pending 卡：result 未到 = undefined（活体帧可补状态）
          out.push({
            kind: 'tool',
            call,
            result: results.get(call.toolCallId),
            liveTool: live?.tools.get(call.toolCallId),
          });
        }
      } else if (msg.type === 'toolResult' && !seenCalls.has(msg.toolCallId)) {
        // 孤儿结果（前置 call 不在投影——异源恢复会话防御）：独立成卡
        seenCalls.add(msg.toolCallId);
        out.push({
          kind: 'tool',
          call: {
            type: 'toolCall',
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            arguments: msg.arguments ?? '',
          },
          result: msg,
          liveTool: undefined,
        });
      }
    }
    // 活体尾部：流式文本（投影尾部同文去重）+ 未入投影的工具卡
    if (live !== null) {
      const lastAssistant = [...messages].reverse().find((m) => m.type === 'assistant');
      const duplicated =
        live.streamText !== '' && lastAssistant !== undefined && textOf(lastAssistant.content) === live.streamText;
      if (live.streamText !== '' && !duplicated) {
        out.push({ kind: 'assistant', text: live.streamText, streaming: !live.streamDone });
      }
      for (const [callId, tool] of live.tools) {
        if (seenCalls.has(callId)) continue; // 投影已含（tool/call 落账）——真值面
        out.push({
          kind: 'tool',
          call: { type: 'toolCall', toolCallId: callId, toolName: tool.name, arguments: tool.argsText ?? '' },
          result: undefined,
          liveTool: tool,
        });
      }
    }
    return out;
  }, [messages, live]);

  /* 自动贴底（消息/活体变化——用户上滚查看历史时不打扰的交互属呈现增强，v1 恒贴底） */
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <main ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {items.map((item, i) => {
          if (item.kind === 'user') {
            return (
              <div
                key={i}
                className="self-end max-w-[85%] rounded-2xl rounded-br-sm bg-neutral-800 px-3.5 py-2 text-sm whitespace-pre-wrap"
              >
                {item.text}
              </div>
            );
          }
          if (item.kind === 'assistant') {
            return (
              <div key={i} className="md self-start max-w-full">
                {/* streaming：尾部光标块（animate-pulse）——收束后隐 */}
                <ReactMarkdown>{item.text + (item.streaming ? ' ◍' : '')}</ReactMarkdown>
              </div>
            );
          }
          return (
            <ToolCard
              key={`t-${item.call.toolCallId}`}
              call={item.call}
              result={item.result}
              liveTool={item.liveTool}
            />
          );
        })}
        {items.length === 0 && <div className="py-10 text-center text-sm text-neutral-600">空会话——发送第一条消息</div>}
      </div>
    </main>
  );
}

/** 工具卡属性 */
interface ToolCardProps {
  readonly call: ProjectedToolCall;
  readonly result: ToolResultMessage | undefined;
  readonly liveTool: { name: string; argsText?: string; output?: string; isError?: boolean; done: boolean } | undefined;
}

/**
 * 工具调用卡（pending → done/error 三态）。输出与状态双源合并：投影 result
 * 为真值优先，活体帧补窗口期（result 未落账但 tool_execution_end 已到）。
 */
function ToolCard({ call, result, liveTool }: ToolCardProps) {
  const isError = result?.isError ?? liveTool?.isError ?? false;
  const done = result !== undefined || liveTool?.done === true;
  const output = result !== undefined ? previewOf(result.output) : liveTool?.output;
  const argsText = result?.arguments ?? liveTool?.argsText ?? call.arguments ?? '';
  const glyph = !done ? '⏳' : isError ? '✗' : '✓';
  const stateColor = !done ? 'text-neutral-400' : isError ? 'text-red-400' : 'text-emerald-500';
  return (
    <details className="group self-start w-full rounded-lg border border-neutral-800 bg-neutral-900/60 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 select-none">
        <span className={`font-mono ${stateColor}`}>{glyph}</span>
        <span className="font-mono text-neutral-300">{call.toolName}</span>
        <span className="text-xs text-neutral-600">{done ? (isError ? '出错' : '完成') : '执行中…'}</span>
      </summary>
      <div className="border-t border-neutral-800 px-3 py-2">
        {argsText !== '' && (
          <div>
            <div className="mb-1 text-xs text-neutral-500">参数</div>
            <pre className="overflow-x-auto rounded-md bg-neutral-950 p-2 font-mono text-xs text-neutral-400">
              {argsText}
            </pre>
          </div>
        )}
        {output !== undefined && output !== '' && (
          <div className="mt-2">
            <div className="mb-1 text-xs text-neutral-500">输出</div>
            <pre
              className={`max-h-64 overflow-auto rounded-md bg-neutral-950 p-2 font-mono text-xs ${isError ? 'text-red-300' : 'text-neutral-300'}`}
            >
              {output}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
