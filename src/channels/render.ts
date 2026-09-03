/**
 * L4 channels — 消息与事件 → 展示行的内置渲染（纯函数，可测）。
 *
 * 通道渲染总入口 renderAgentMessage：自定义渲染器（ctx.channels.
 * registerRenderer）优先，回落内置三角色形态；自定义角色查 agent 模块的
 * render intent（inline/status/hidden）。展示行是纯文本（无 ANSI），排版
 * 着色由通道壳决定。
 */

import type { AgentMessage } from '../contracts/messages.js';
import { getMessageRoleDefinition, isStandardMessage } from '../contracts/messages.js';
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage, UserMessage } from '../contracts/llm.js';
import type { RendererDefinition } from './types.js';

/** 展示行截断上限（单行摘要用；全文渲染不走这里） */
const BRIEF_MAX = 160;

/**
 * 单行摘要截断（超长加省略号）。切片按**码点**（`[...text]` 展开）——UTF-16
 * 原生 slice 会在边界把 4 字节 emoji 切成孤代理项，终端渲染为乱码问号
 * （TUI-5：⚙ 工具摘要 / ✖ 错误行 / ↳ 结果行三个触发面同走此单点，一处修
 * 全覆盖）。触发判据仍是 UTF-16 长度（截断门槛不变，只有切法换码点）。
 */
export function truncate(text: string, max: number = BRIEF_MAX): string {
  if (text.length <= max) return text;
  return `${[...text].slice(0, max - 1).join('')}…`;
}

/** 拼接文本/图片内容块的文本部分（图片块以占位符表示） */
export function joinTextContent(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text' ? block.text : '[图片]')).join('\n');
}

/** assistant 消息当前文本（text 块拼接；thinking 块不进展示正文） */
export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** assistant 消息内工具调用行（⚙ 工具名 + 参数摘要） */
export function assistantToolLines(message: AssistantMessage): string[] {
  return message.content
    .filter((block) => block.type === 'toolCall')
    .map((block) => (block.type === 'toolCall' ? `⚙ ${block.name} ${truncate(JSON.stringify(block.arguments))}` : ''));
}

/**
 * assistant 消息失败行（基建大扫 #42）：errorMessage 在场（stopReason=
 * error/aborted——错误即数据）时产出一条 ✖ [错误] 行，缺席返回空数组。
 * content 空的失败 run（模型零产出只余错误）此前一行都不出——失败在
 * 屏上不可见；此行是 TUI 正文与流式收尾共用的唯一失败呈现面。
 */
export function assistantErrorLine(message: AssistantMessage): string[] {
  return message.errorMessage !== undefined ? [`✖ [错误] ${truncate(message.errorMessage)}`] : [];
}

// 工具行渲染单源（20260901-d #5）：直播 ⚙ 行走 assistantToolLines（随
// message_end）、↳/✖ 行走 renderToolResult（随 toolResult message_start）——
// 原 formatToolStart/formatToolEnd 两旧形态函数自单源定稿后零生产消费者，
// 第十轮 TUI 专项扫雷 TUI-6 连同测试与再导出一并收册删除。

/** 内置 user 消息行（❯ 前缀；多行保持） */
function renderUser(message: UserMessage): string[] {
  const text = joinTextContent(message.content).trim();
  return text ? text.split('\n').map((line, i) => (i === 0 ? `❯ ${line}` : `  ${line}`)) : [];
}

/** 内置 toolResult 消息行（与 tool_execution_end 事件同形，供历史投影渲染） */
function renderToolResult(message: ToolResultMessage): string[] {
  const brief = truncate(joinTextContent(message.content).trim().split('\n')[0] ?? '');
  return [brief ? `${message.isError ? '✖' : '↳'} ${brief}` : '↳'];
}

/** 内置自定义角色行（render intent 决定形态；未注册角色按 inline 兜底） */
function renderCustom(role: string, content: unknown): string[] {
  const def = getMessageRoleDefinition(role);
  // hidden = 声明不渲染；status 意图由通道壳走状态行（此处按 inline 单行兜底）
  if (def?.render?.intent === 'hidden') return [];
  const label = def?.render?.label ?? role;
  const brief = typeof content === 'string' ? content : truncate(JSON.stringify(content));
  return [`[${label}] ${brief}`];
}

/**
 * 消息渲染总入口：自定义渲染器优先（按角色注册的后写胜出者），
 * 回落内置形态。返回空数组 = 该消息不展示。
 *
 * 渲染器异常隔离（契约篇 §1.6 监听器异常隔离在渲染面的执法，隔离案一第一刀
 * #1——消 P15/P16 进程退出级）：自定义 render 抛错被捕获并上报诊断回调，
 * 该消息回落内置形态——事件流与历史渲染两条路径共用本入口，一处包裹全覆盖。
 * @param onRendererError 渲染器异常诊断回调（角色名归因；装配层接 logger.error）
 */
export function renderAgentMessage(
  message: AgentMessage,
  rendererFor?: (role: string) => RendererDefinition | undefined,
  onRendererError?: (err: unknown, role: string) => void,
): string[] {
  const custom = rendererFor?.(message.role);
  if (custom) {
    try {
      return custom.render(message);
    } catch (err) {
      // 坏渲染器不杀进程：上报后回落内置形态（诊断不丢，事件流不毒）
      onRendererError?.(err, message.role);
    }
  }

  // 正向守卫窄化：真分支 = 标准三角色，假分支 = CustomMessage（render intent）
  if (isStandardMessage(message)) {
    switch (message.role) {
      case 'user':
        return renderUser(message);
      case 'assistant': {
        const lines = assistantText(message)
          .split('\n')
          .filter((line) => line !== '');
        // 失败行垫尾（#42）：部分产出后失败时正文/工具行在前，错误真相压轴
        return [...lines, ...assistantToolLines(message), ...assistantErrorLine(message)];
      }
      case 'toolResult':
        return renderToolResult(message);
    }
  }
  return renderCustom(message.role, message.content);
}
