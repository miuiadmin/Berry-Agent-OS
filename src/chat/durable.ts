/**
 * L4 chat — durable 事件接线（对话应用件本体：活体事件 → 会话事件日志的映射——铭牌批随件迁入聚落）。
 *
 * 三件东西：
 * ① createDurableSinks：loop 的 AgentEvent → session.append（消息级组装结果 +
 *    turn 边界；token 级 chunk / agent 边界不落日志——骨架篇 §2.5 分层纪律）；
 * ② 守门决议 sink（pipeline onGateDecision → gate/decision）与审批对 sink
 *    （approval → approval/asked + approval/decided）；
 * ③ projectedToAgentMessages：历史投影（ProjectedMessage）→ AgentMessage
 *    （恢复会话续跑 / TUI 历史渲染的形状适配——durable 是压缩态，回读要还原）。
 *
 * 追加顺序不变式（derive fold 依赖，会话篇 §3）：assistant/message 先落、
 * 逐 toolCall 块续落 tool/call、tool/result 到达时 assistant 缓冲已具备配对信息。
 */

import type { AgentEvent } from '../agent/events.js';
import type { AgentMessage } from '../contracts/messages.js';
import { isStandardMessage } from '../contracts/messages.js';
import type { StopReason, TextContent, ToolCallBlock, Usage } from '../contracts/llm.js';
import type { ImageContent, ThinkingContent, ToolResultMessage, UserMessage } from '../contracts/llm.js';
import type { GateDecisionPayload, GateDecisionSink } from '../contracts/tools.js';
import type { Session } from '../session/session.js';
import type { ProjectedMessage } from '../session/derive.js';
import type { TurnEndReason } from '../session/event-types.js';
import { usageLedgerBuckets, ledgerModel, turnUsageCallId } from '../session/event-types.js';
import type { ApprovalDecisionSink } from '../safety/approval.js';

/** 组合根持有的 durable 接线面（loop emit 的持久化半边 + 两个结构化 sink） */
export interface DurableSinks {
  /** loop 活体事件 → durable（emit 扇出的持久化半边） */
  handle(event: AgentEvent): void;
  /** 守门决议落 durable（接 pipeline 的 onGateDecision） */
  readonly gate: GateDecisionSink;
  /** 审批对落 durable（接 approval 服务的 sink） */
  readonly approval: ApprovalDecisionSink;
}

/** StopReason（LLM 七值）→ TurnEndReason（会话六值）映射 */
function stopReasonToTurnEnd(reason: StopReason): TurnEndReason {
  switch (reason) {
    case 'stop':
    case 'toolUse':
    case 'pending':
    case 'deferred':
      return 'completed';
    case 'length':
      return 'max-tokens';
    case 'error':
      return 'error';
    case 'aborted':
      return 'aborted';
  }
}

/** 工具结果错误码（M1 通用码：ToolResultMessage 只携带 isError 布尔，具体码不回传） */
const TOOL_ERROR_CODE = 'TOOL_ERROR';

/** 内容块首段文本（错误说明用；无文本块返回 undefined） */
function firstText(content: readonly (TextContent | ImageContent)[]): string | undefined {
  const text = content.find((block): block is TextContent => block.type === 'text');
  return text?.text;
}

/**
 * durable 内容预算（字节）：session 事件护栏 64KiB 扣除事件元数据（type/seq/
 * toolCallId/error 头部）后的内容可用上限。写侧截断是护栏矛盾的宿主单点解——
 * fs read 上限 256KiB > 会话护栏 64KiB，若不在落账前截断，读大文件必在
 * append 抛 SESSION_EVENT_TOO_LARGE 并沿 emit 上抛炸掉整个 run
 * （独立重读轮 #9 复核坐实，2026-08-23 修）。
 */
const DURABLE_CONTENT_BUDGET_BYTES = 60 * 1024;

/** 截断尾标记（读侧可识别「内容被 durable 预算裁过」——投影/模型侧语义损失显式化） */
const TRUNCATED_MARKER = '\n…[truncated for durable log]';

/**
 * durable 内容块类型（截断器覆盖三种载荷块：user=text/image、
 * assistant=text/thinking、toolResult=text/image）。toolCall **不在其列**：
 * content 腿不内联 toolCall 块（tool/call 事件是唯一承载腿，双载必在投影
 * 回读时拼出重复块——会话篇 §1.1，2026-08-23 修）。
 */
type DurableBlock = TextContent | ThinkingContent | ImageContent;

/** 单块 UTF-8 字节度量（截断预算的计量单位；image 按 base64 字符串长度近似） */
function blockBytes(block: DurableBlock): number {
  switch (block.type) {
    case 'text':
      return Buffer.byteLength(block.text, 'utf8');
    case 'thinking':
      return Buffer.byteLength(block.thinking, 'utf8');
    case 'image':
      return block.data.length;
  }
}

/**
 * 字符串按字节预算截断（超预算加尾标记；不超原样返回）。
 * user 纯文本整串与 tool/call 的 arguments 字符串共用这一把刀。
 */
function budgetString(text: string): string {
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= DURABLE_CONTENT_BUDGET_BYTES) return text;
  // 按字节截（subarray 可能切在多字节字符中间，toString 对坏尾替换 U+FFFD——可接受）
  const sliced = Buffer.from(text, 'utf8').subarray(0, DURABLE_CONTENT_BUDGET_BYTES).toString('utf8');
  return sliced + TRUNCATED_MARKER;
}

/**
 * 内容截断到 durable 预算内（块数组形态：text/thinking 块按剩余预算截字节
 * 并加尾标记，image 块放不下时换文本占位——base64 动辄超预算，保留语义不保像素）。
 * 不超预算时原样返回（零成本快路径）。
 */
function truncateForDurable(content: string | readonly DurableBlock[]): string | readonly DurableBlock[] {
  // 纯字符串形态（user 消息）：整串按字节截
  if (typeof content === 'string') {
    return budgetString(content);
  }
  // 快路径：总字节在预算内直接通过（绝大多数消息零开销）
  let total = 0;
  for (const block of content) {
    total += blockBytes(block);
  }
  if (total <= DURABLE_CONTENT_BUDGET_BYTES) return [...content];

  const out: DurableBlock[] = [];
  let budget = DURABLE_CONTENT_BUDGET_BYTES;
  for (const block of content) {
    if (block.type === 'image') {
      // 像素载荷放不进预算 → 文本占位（像素本就不进 durable——事件日志是审计面非媒体库）
      out.push({ type: 'text', text: '[image omitted: durable budget]' });
      continue;
    }
    // text / thinking：按剩余预算截字节
    const text = block.type === 'text' ? block.text : block.thinking;
    const size = Buffer.byteLength(text, 'utf8');
    if (size <= budget) {
      out.push(block);
      budget -= size;
      continue;
    }
    if (budget > 0) {
      // 按字节截（subarray 可能切在多字节字符中间，toString 对坏尾替换 U+FFFD——可接受）
      const sliced = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8');
      const marked = sliced + TRUNCATED_MARKER;
      out.push(block.type === 'text' ? { type: 'text', text: marked } : { type: 'thinking', thinking: marked });
      budget = 0;
    }
    // 预算耗尽后的剩余 text/thinking 块整块丢弃（尾标记已声明截断事实）
  }
  return out;
}

/**
 * 组装 durable 接线面。session.append 的抛错（如载荷不可 JSON 化）直接上抛——
 * 按「回调违约由 app 装配层兜底」纪律，由会话驱动统一合成 error 收尾。
 *
 * @param options.model 装配期模型标识（"provider/model-id"）——llm/usage 前台折叠
 *   的 model 腿回退值（消息自带 model 缺席时使用；与结算通知器注入同源）
 * @param options.usagePriority 本会话主 loop 花销的记账道（缺省 'foreground'）。
 *   tick 唤起入口声明 background 归属（内核边界篇 §4.1 席 13 第二刀、骨架篇
 *   §8.7 blocker 修）：argv --background → run 入口 → runtime 选项 → 此处。
 *   否则 tick 子进程花 foreground 道、闸读 background 道，never-unbounded
 *   执法恒空转。整进程会话级声明（tick 子进程整个会话都是无人值守轮）；
 *   宿主前台风暴轮与 tick 子进程轮同一会话时各记各道（事件按笔归属，天然分流）
 */
export function createDurableSinks(
  session: Session,
  options: { model?: string; usagePriority?: 'background' | 'foreground' } = {},
): DurableSinks {
  const handle = (event: AgentEvent): void => {
    switch (event.type) {
      case 'turn_start':
        session.append('turn/start', {});
        return;
      case 'turn_end': {
        // turn 终态锚定本 turn assistant 消息的 stopReason（三套终态枚举的换算点）
        session.append('turn/end', { reason: stopReasonToTurnEnd(event.message.stopReason) });
        return;
      }
      case 'message_end': {
        const message = event.message;
        // 自定义角色 M1 无内置注册者（角色注册是装载面），无处产生即无需落点；
        // 应用期若引入自定义角色，须先扩事件词汇再在此接线（未覆盖≠驳回）
        if (!isStandardMessage(message)) return;
        if (message.role === 'user') {
          // source / attribution 归因落账（会话篇 §3.1 + 骨架篇 §6.8 刀三——谁把
          // 这条消息放进历史 + 轮身份键值对；缺省不落字段）
          session.append('user/message', {
            content: truncateForDurable(message.content),
            ...(message.source !== undefined ? { source: message.source } : {}),
            ...(message.attribution !== undefined ? { attribution: message.attribution } : {}),
          });
          return;
        }
        if (message.role === 'assistant') {
          // 消息终态 + 逐工具调用块（arguments 落原始字符串——解析失败留给工具管道）。
          // content 滤除 toolCall 块：tool/call 事件是工具调用的唯一 durable 承载腿，
          // content 内联 + 事件双载会在投影回读时拼出重复 toolCall 块（会话篇 §1.1，
          // 2026-08-23 修）——滤除同时让 text/thinking 不被 toolCall arguments 挤占预算
          const appended = session.append('assistant/message', {
            content: truncateForDurable(message.content.filter((block) => block.type !== 'toolCall')),
            usage: message.usage,
            stopReason: message.stopReason,
          });
          // 底账统一真实请求（2026-08-25 应用面第二纵切拍板，契约篇 §5.4）：主 loop
          // 前台花销同落 llm/usage（缺省 foreground 道）——此前只 complete 单发进账，
          // 前台主对话花销不进任何账（canAfford「自然成立」证伪的冷读硬伤修复）。
          // tick 唤起会话声明 background 道（第二刀 blocker 修——见函数头注记）。
          // origin!=='delegation' 守卫防双重计数：delegation 子会话花销由结算折叠
          // （app/notify.ts——折进父会话 background 道）覆盖，子会话不再自折一笔。
          // callId = 轮身份（assistant/message 事件的 seq——write-behind 重试去重锚点，
          // 同会话内天然唯一且幂等）。'turn:' 前缀经 event-types 判别式三函数同源
          // 构造（复盘 20260901 R-1——goal ④ 预算腿按前缀排除本腿笔防双计）
          if (message.usage !== undefined && session.header.origin !== 'delegation') {
            session.append('llm/usage', {
              callId: turnUsageCallId(session.header.sessionId, appended.seq),
              // model 口径统一（P1-5）：实录优先——provider+model 拼全形，请求标识
              // 兜底（修偏前落裸 model id——与 complete 写点两种口径）
              model: ledgerModel(message, options.model),
              priority: options.usagePriority ?? 'foreground',
              // 全桶入账（会话篇 §1.1 P1-5 修偏，挖矿 B3）：usageLedgerBuckets
              // 归一——此前手写 {input,output} 裁掉 cacheRead/cacheWrite，读侧
              // /usage 面板（四桶总和）与底账长期两张皮
              usage: usageLedgerBuckets(message.usage),
            });
          }
          for (const block of message.content) {
            if (block.type === 'toolCall') {
              session.append('tool/call', {
                toolCallId: block.id,
                name: block.name,
                // arguments 过 durable 预算截断：写类工具参数无上限、模型单轮输出可达
                // 64k token——call 侧与 result 侧同链可炸 64KiB 护栏（#9 修 a 的对侧腿）；
                // 截断后读侧 JSON 解析失败回空对象，与首次落库解析失败对称降级
                arguments: budgetString(JSON.stringify(block.arguments)),
              });
            }
          }
          return;
        }
        // toolResult：isError 携带通用错误码 + 首段文本说明（durable 写码不写长文）
        session.append('tool/result', {
          toolCallId: message.toolCallId,
          content: truncateForDurable(message.content),
          ...(message.isError ? { error: { code: TOOL_ERROR_CODE, message: firstText(message.content) } } : {}),
        });
        return;
      }
      default:
        // agent_start/agent_end/message_start/message_update/tool_execution_* 不落
        // durable——token 级与生命周期边界走活体事件面（骨架篇 §2.5 分层纪律）
        return;
    }
  };

  return {
    handle,
    gate: (payload: GateDecisionPayload) => {
      session.append('gate/decision', payload);
    },
    approval: {
      asked: (payload) => {
        session.append('approval/asked', payload);
      },
      decided: (payload) => {
        session.append('approval/decided', payload);
      },
    },
  };
}

/* ---------------- 历史投影回读适配（ProjectedMessage → AgentMessage） ---------------- */

/** 零用量兜底（投影缺 usage 时的占位——Usage 是 AssistantMessage 必填） */
const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/** tool/call 的 arguments 字符串还原为对象（解析失败回空对象——与首次落库失败对称） */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 历史投影 → AgentMessage 序列（恢复续跑的上下文重建 / TUI 历史渲染共用）。
 * timestamp 不在 durable 内（事件信封有 time），回读置 0——展示层不依赖它，
 * loop 上下文重建也不读历史时间戳（只新消息带真实时间）。
 */
export function projectedToAgentMessages(projected: readonly ProjectedMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const message of projected) {
    switch (message.type) {
      case 'user':
        out.push({
          role: 'user',
          content: message.content as UserMessage['content'],
          timestamp: 0,
          // source / attribution 归因还原（会话篇 §3.1 全链最后一腿 + 骨架篇 §6.8
          // 刀三——回读后注入方身份与轮身份不丢）
          ...(message.source !== undefined ? { source: message.source } : {}),
          ...(message.attribution !== undefined ? { attribution: message.attribution } : {}),
        });
        break;
      case 'assistant': {
        // 工具调用块由 tool/call 事件合成（投影分离态）——还原为 assistant 内联块。
        // content 里的 toolCall 块防御性滤除：写侧已不内联（§1.1），此过滤只为
        // 兼容修复前落库的旧形状日志（旧日志内联块 + 事件块重拼 = 重复 tool_use）
        const inlineBlocks = ((message.content ?? []) as (TextContent | ThinkingContent | ToolCallBlock)[]).filter(
          (block) => block.type !== 'toolCall',
        );
        const blocks = [
          ...inlineBlocks,
          ...message.toolCalls.map((call): ToolCallBlock => ({
            type: 'toolCall',
            id: call.toolCallId,
            name: call.toolName,
            arguments: parseToolArguments(call.arguments),
          })),
        ];
        out.push({
          role: 'assistant',
          content: blocks,
          usage: (message.usage as Usage | undefined) ?? NO_USAGE,
          stopReason: (message.stopReason as StopReason | undefined) ?? 'stop',
          timestamp: 0,
        });
        break;
      }
      case 'toolResult':
        out.push({
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.output as ToolResultMessage['content'],
          isError: message.isError,
          timestamp: 0,
        });
        break;
    }
  }
  return out;
}
