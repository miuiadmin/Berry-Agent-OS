/**
 * 对话内联 Block 模型（前端镜像 src/contracts/message-blocks.ts，设计文档/22）。
 *
 * 核心理念：对话内容统一为有序 block 数组，对齐 Claude Code（content blocks）/ OpenCode（parts）。
 * 工具调用 / 推理 / 委派不再是消息气泡之外的「平行流」，而是消息内的内联 block。
 *
 * 本文件是前端的纯逻辑层（无 React / zustand 依赖）：
 *   - Block 判别联合（与后端契约同形）
 *   - applyBlockToBlocks：stream.block 事件 → Block[] 的纯 reducer（store 用）
 *   - textFromBlocks：block-first 正文投影（MessageActions copy / fallback 用，TextBlock 优先回退 content）
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

/** 推理 block（可折叠思考过程）。id 语义同 TextBlock。durationMs = 思考耗时（前端显示「思考了 Ns」）。 */
export interface ThinkingBlock {
  type: 'thinking';
  id?: string;
  text: string;
  /** 思考耗时（毫秒），后端 BlockCollector 按「首 reasoning delta → 首文字/工具」计算 */
  durationMs?: number;
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

/**
 * Brain 编排动作 block（内联编排卡：correction 纠偏 / signal_intervention 介入 / checker_dispatch 派审）。
 * live-only：实时显示但不落库，刷新后不保留（见后端 contracts/message-blocks.ts OrchestrationBlock）。
 */
export interface OrchestrationBlock {
  type: 'orchestration';
  /** 幂等键（`${messageId}#orch#${action}_${createdAt}`） */
  id: string;
  action: 'correction' | 'signal_intervention' | 'checker_dispatch';
  /** 目标 agent */
  target?: string;
  /** 严重度（correction / signal_intervention） */
  severity?: 'low' | 'medium' | 'high';
  /** 指令/原因摘要 */
  detail?: string;
}

/**
 * 任务进展卡 block（§14.5 主界面：会自己生长的 block，让用户在对话里感知任务板推进）。
 * live-only：随 board 协作实时更新（稳定 blockId = `${messageId}#taskprog`，同板 upsert 更新非重复建），
 * 不落库，刷新后消失。见后端 contracts/message-blocks.ts TaskProgressBlock。
 */
export interface TaskProgressBlock {
  type: 'task_progress';
  /** 稳定 blockId（`${messageId}#taskprog`），同板多次更新 upsert 同一块 */
  id: string;
  goal: string;
  status: string;
  leader?: string;
  members?: string[];
  turnCount?: number;
  maxTurns?: number;
  spawnDepth?: number;
  /** 近期活动一行摘要（如「3指派 2成果 1纠偏」） */
  activitySummary?: string;
}

/** Block 判别联合——对话内容的统一模型 */
export type Block = TextBlock | ThinkingBlock | ToolBlock | DelegationBlock | ReviewBlock | OrchestrationBlock | TaskProgressBlock;

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
  blockType: 'text' | 'thinking' | 'tool' | 'delegation' | 'review' | 'orchestration' | 'task_progress';
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

  // text / thinking 整体替换（无 delta，带 block）：markReasoningEnd emit thinking block 带 durationMs
  // （live 显示「思考了 Ns」）；按 blockId upsert，使流式结束瞬间即显示计时（不必等落库刷新）
  if ((p.blockType === 'text' || p.blockType === 'thinking') && p.block && p.delta == null) {
    const idx = list.findIndex((b) => b.type === p.blockType && (b as { id?: string }).id === p.blockId);
    if (idx >= 0) {
      const copy = list.slice();
      copy[idx] = p.block;
      return copy;
    }
    return [...list, p.block];
  }

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

  // review：按 type 定位 upsert（Brain 审核裁决，整体替换）。ReviewBlock 无 id 字段，
  // 且一轮至多一个审核 → 直接 findIndex type==='review'（与 tool/delegation 同「整体替换」机制）。
  if (p.blockType === 'review' && p.block) {
    const idx = list.findIndex((b) => b.type === 'review');
    if (idx >= 0) {
      const copy = list.slice();
      copy[idx] = p.block;
      return copy;
    }
    return [...list, p.block];
  }

  // orchestration：按 blockId upsert（整体替换，与 tool/delegation 同机制——编排动作出生即终态）。
  // live-only 块：只 live 累积在 message.blocks，落库路径不含（刷新后消失）。
  if (p.blockType === 'orchestration' && p.block) {
    const idx = list.findIndex((b) => b.type === 'orchestration' && (b as { id: string }).id === p.blockId);
    if (idx >= 0) {
      const copy = list.slice();
      copy[idx] = p.block;
      return copy;
    }
    return [...list, p.block];
  }

  // task_progress：稳定 blockId（`${messageId}#taskprog`），同板 upsert 更新同一块（非堆叠，§14.5 会生长的卡）。
  // live-only 块：只 live 累积，落库路径不含（刷新后消失）。
  if (p.blockType === 'task_progress' && p.block) {
    const idx = list.findIndex((b) => b.type === 'task_progress');
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
 * 从 blocks 抽取正文文本（TextBlock.text 拼接）；无 TextBlock 则返回 fallback。
 * block-first 渲染点（文本气泡 / MessageActions）用此优先读 TextBlock（单一事实源），
 * 回退 content（兼容无 text block 的历史消息 / 过渡期）。消灭双源后 fallback 仅历史消息触发。
 */
export function textFromBlocks(blocks: Block[] | undefined, fallback = ''): string {
  const text = (blocks ?? [])
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('') // 文本段是原文按工具边界切分（无分隔）→ join '' 还原连续原文；与后端 extractTextFromBlocks 一致（旧 '\n' 在工具边界插假换行）
    .trim();
  return text || fallback;
}

// 对话内联（doc 22 Phase D）：旧 toolCalls[] → ToolBlock[] 投影（toolBlocksFromLegacy）已删——
// 消灭双轨制后所有路径都 emit stream.block tool，message.blocks 即工具唯一源，无需 legacy 兜底。
