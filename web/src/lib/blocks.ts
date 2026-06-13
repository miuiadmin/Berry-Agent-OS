/**
 * 对话内联 Block 模型（前端镜像 src/contracts/message-blocks.ts，设计文档/22）。
 *
 * 核心理念：对话内容统一为有序 block 数组，对齐 Claude Code（content blocks）/ OpenCode（parts）。
 * 工具调用 / 推理 / 委派不再是消息气泡之外的「平行流」，而是消息内的内联 block。
 *
 * 本文件是前端的纯逻辑层（无 React / zustand 依赖）：
 *   - Block 判别联合（与后端契约同形）
 *   - applyBlockToBlocks：stream.block 事件 → Block[] 的纯 reducer（store 用）
 *   - toolBlocksFromLegacy：旧 toolCalls[] → ToolBlock[] 投影（历史消息 / 无 block 事件的路径兜底）
 *
 * 文本不进 block 数组：文本正文仍由 ChatMessage.content 承载（覆盖 task-flow 与 delegation-orchestrator
 * 两条流式路径），block 数组只承载「原先被分离出去」的 tool / thinking / delegation。这避免文本重复，
 * 且精准命中用户痛点（工具调用分离）。
 */

/** ToolBlock 4 态机（OpenCode 式 call+result 同一 block）：pending→running→completed|failed */
export type ToolBlockState = 'pending' | 'running' | 'completed' | 'failed';

/** DelegationBlock 状态机：委派生命周期（含被中断） */
export type DelegationBlockState = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';

/** 文本 block（正文）。id 仅流式期间用于按 blockId 去重追加，渲染层忽略。 */
export interface TextBlock {
  type: 'text';
  /** 流式 blockId（`${messageId}#text`），store 追加 delta 时按此去重；投影/历史块无 id */
  id?: string;
  text: string;
}

/** 推理 block（可折叠思考过程）。id 语义同 TextBlock。 */
export interface ThinkingBlock {
  type: 'thinking';
  id?: string;
  text: string;
}

/** 工具调用 block（内联工具卡）。出生即终态（task.telemetry 一次性带 input/output）。 */
export interface ToolBlock {
  type: 'tool';
  /** 稳定 id（`${messageId}#tool#${name}#${seq}`）；legacy 投影用 `legacy-${name}-${ts}` */
  id: string;
  name: string;
  input: unknown;
  state: ToolBlockState;
  /** 工具输出（结构化或原始字符串） */
  output?: unknown;
  /** 失败时的错误信息（isError && result） */
  error?: string;
  /** 耗时（毫秒）；daemon 路径可能缺失 */
  durationMs?: number;
}

/** 委派 block（Brain→子 agent 委派，可展开嵌套子会话）。期4 落地。 */
export interface DelegationBlock {
  type: 'delegation';
  id: string;
  targetAgent: string;
  state: DelegationBlockState;
  /** 委派摘要（子 agent 完成后回填） */
  summary?: string;
  /** 子会话 id（展开时拉嵌套 timeline 渲染） */
  childSessionId?: string;
}

/** Brain 审核 block（裁决徽章）。当前由 reviewVerdict 旧字段承载，本类型预留统一。 */
export interface ReviewBlock {
  type: 'review';
  verdict: 'approve' | 'modify' | 'reject';
  reason?: string;
  originalDraft?: string;
}

/** Block 判别联合——对话内容的统一模型 */
export type Block = TextBlock | ThinkingBlock | ToolBlock | DelegationBlock | ReviewBlock;

/**
 * stream.block 事件载荷（后端 StreamBlockPayload 的前端镜像，见 contracts/message-blocks.ts）。
 * ws 消息 type 为 'block'（ws-event-bridge 单映射 stream.block → block）。
 */
export interface StreamBlockPayload {
  /** ws 消息 type（前端 ServerMessage 联合里的判别字段） */
  type?: 'block';
  sessionId: string;
  /** 后端本轮 assistant 消息 id（前端聚合同轮 block 的 key；不等于前端 ChatMessage.id） */
  messageId: string;
  /** block 唯一键（text/thinking 为 `${messageId}#text|#thinking`；tool 为 `${messageId}#tool#${name}#${seq}`） */
  blockId: string;
  blockType: 'text' | 'thinking' | 'tool' | 'delegation' | 'review';
  /** 创建事件携带完整 block（tool/delegation 出生即终态）；text/thinking 无此字段 */
  block?: Block;
  /** tool/delegation 状态（冗余于 block.state，便于不携带完整 block 的 patch 事件） */
  state?: string;
  /** text/thinking 增量文本 */
  delta?: string;
  ts: number;
  taskId?: string;
  correlationId?: string;
}

/**
 * 把 stream.block 事件应用到 Block[]（纯 reducer，前端 store 用）。
 *   - text/thinking：按 blockId 找块追加 delta（找不到则惰性建块）。
 *   - tool/delegation：按 blockId upsert（payload.block 整体替换；出生即终态）。
 *   - review：按 blockId upsert。
 * 不可变更新（返回新数组），契合 zustand set。
 */
export function applyBlockToBlocks(blocks: Block[] | undefined, p: StreamBlockPayload): Block[] {
  const list = blocks ?? [];

  // text / thinking 增量追加
  if ((p.blockType === 'text' || p.blockType === 'thinking') && p.delta != null) {
    const idx = list.findIndex((b) => b.type === p.blockType && (b as { id?: string }).id === p.blockId);
    if (idx >= 0) {
      const copy = list.slice();
      const cur = copy[idx] as TextBlock | ThinkingBlock;
      copy[idx] = { ...cur, text: cur.text + (p.delta ?? '') };
      return copy;
    }
    // 惰性建块
    const created: Block =
      p.blockType === 'text'
        ? { type: 'text', id: p.blockId, text: p.delta }
        : { type: 'thinking', id: p.blockId, text: p.delta };
    return [...list, created];
  }

  // tool / delegation：按 blockId upsert（整体替换）
  if ((p.blockType === 'tool' || p.blockType === 'delegation') && p.block) {
    const idx = list.findIndex(
      (b) => (b.type === 'tool' || b.type === 'delegation') && (b as { id: string }).id === p.blockId,
    );
    if (idx >= 0) {
      const copy = list.slice();
      copy[idx] = p.block;
      return copy;
    }
    return [...list, p.block];
  }

  return list;
}

/**
 * 把字符串规整为结构化载荷：尝试 JSON.parse，失败则原样返回字符串；空串返回 undefined。
 * 与后端 block-collector.ts 的 coercePayload 同义（tool input/result 规整）。
 */
function coercePayload(s: string | undefined | null): unknown {
  if (s == null || s === '') return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s; // 非结构化文本：保留原串
  }
}

/**
 * 旧 ToolCallEvent（前端的 toolCalls[] 数组项）——只取渲染 block 需要的字段。
 * 与 chat-store.ts 的 ToolCallEvent 形状对齐（避免循环 import，这里局部定义）。
 */
interface LegacyToolCall {
  toolName: string;
  input: string;
  result: string;
  isError: boolean;
  durationMs: number;
  ts: number;
}

/**
 * 旧字段（toolCalls[]）→ ToolBlock[] 投影。
 * 用于历史消息 / 无 stream.block 事件的流式路径兜底（如 delegation-orchestrator 的工具调用不经 block 事件）。
 * 顺序由调用方保证（thinking 由 reasoning 单独承载；这里只产出 tool block）。
 */
export function toolBlocksFromLegacy(calls: LegacyToolCall[] | undefined): ToolBlock[] {
  if (!calls?.length) return [];
  return calls.map((tc, i) => {
    const block: ToolBlock = {
      type: 'tool',
      id: `legacy-${tc.toolName}-${tc.ts ?? i}`,
      name: tc.toolName,
      input: coercePayload(tc.input) ?? {},
      state: tc.isError ? 'failed' : 'completed',
    };
    const output = coercePayload(tc.result);
    if (output !== undefined) block.output = output;
    if (tc.isError && tc.result) block.error = tc.result;
    // 防御 durationMs 缺失（daemon 路径）：有限数才写入
    if (tc.durationMs != null && Number.isFinite(tc.durationMs)) block.durationMs = tc.durationMs;
    return block;
  });
}
