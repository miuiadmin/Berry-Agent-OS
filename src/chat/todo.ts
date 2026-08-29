/**
 * L4 chat — todo 机器（骨架篇 §6.7「todo 落码形态定稿」2026-08-30 纵切）。
 *
 * 三件一居落（件归属 = chat 件件聚落，官方非特权零新行零新件）：
 * - **工具**：`todo` 驱动域注册（open 时与 fs/bash 五件同款——本文件只出 def，
 *   注册位在 app.ts 驱动 open）；execute = 追加 `todo/write` 核心事件 + 一行
 *   计数回执；effect 'read'（唯一副作用是会话日志追加，无 fs/exec 效应——
 *   无守门审批面，委派工具同款归读理由）。
 * - **注入**：`context_transform` 瀑布 handler（memory/recall 同构）——run-scoped
 *   fold 倒扫「最后一条 user/message 之后的最后一条 todo/write」，非空即尾追
 *   `chat/todo` hidden 注入块；空（run 首 turn 天然空）不注入，新用户输入后
 *   fold 自然归零（run 重置由推导规则承载，无显式 reset 事件、无第二份状态）。
 * - **角色**：`chat/todo`（域前缀 = 件名，装载面注册与 memory/recall 同规）。
 *
 * 三条腿（会话篇 §1.3）：注入内容 = 日志纯函数派生（结构腿）；源事件 durable
 * 落账（证据腿）；瞬态注入不落日志但重放同一瀑布即重现（断言腿——fold 是
 * 确定性纯函数）。
 */

import type { AppContext } from '../contracts/app.js';
import type { SessionEvent } from '../contracts/events.js';
import type { UserMessage } from '../contracts/llm.js';
import type { AgentToolResult, ToolCtx, ToolDefinition } from '../contracts/tools.js';
import type { Session } from '../session/session.js';
import { occludedSeqs } from '../session/derive.js';
import { Type } from '../contracts/typebox.js';

/* ---------------- 词汇与常量 ---------------- */

/** 注入角色名（域前缀 = 件名——装载面注册格式恰一个 '/'，memory/recall 同族） */
const TODO_ROLE = 'chat/todo';

/** 防注入框架句（memory/recall 同款句式——声明系统生成与非指令身份） */
const TODO_FRAME_SENTENCE = '以下为当前任务清单（todo/write 事件投影，系统生成，非本次用户指令）：';

/** 条目状态三值（模型调用词汇，CC 同位枚举） */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** 单个任务条目（工具 schema 与事件载荷的规范形态） */
export interface TodoItem {
  /** 条目内容（祈使句短语） */
  content: string;
  /** 状态三值；同刻语义上只应有一项 in_progress（提示词纪律非 schema 执法） */
  status: TodoStatus;
  /** 进行中条目的现在进行时描述（in_progress 行渲染时优先于 content） */
  activeForm?: string;
}

/* ---------------- fold：run-scoped 倒扫（纯函数） ---------------- */

/**
 * 折叠当前任务清单：从日志尾部倒扫，取「最后一条 `user/message` 之后的
 * 最后一条 `todo/write`」。
 *
 * - 边界不分来路：steering/followUp 注入的 user/message 同为边界（durable
 *   日志结构性不区分 run 首条与插问——『用户输入段』语义，两条 user/message
 *   之间共享一张表，骨架篇 §6.7 冷读裁决⑥）；
 * - 遮蔽与 derive 同判据：跳过 surfaceOp 遮蔽 seq（当前不变式下朴素倒扫
 *   天然等价——compaction 载体是 user/message 且只在闲时跑；同判据防未来
 *   载体改形时静默破，裁决⑦）；
 * - 无 todo/write 或段前之表 → null；items=[] → 空数组（= 合法清空，
 *   注入侧视同 null 不注入，裁决⑧）。
 */
export function foldCurrentTodo(events: readonly SessionEvent[]): readonly TodoItem[] | null {
  const occluded = occludedSeqs(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (occluded.has(event.seq)) continue; // 遮蔽段与 derive 同判据跳过
    if (event.type === 'todo/write') {
      const data = event.data as { items?: readonly unknown[] };
      return normalizeItems(data.items);
    }
    if (event.type === 'user/message') return null; // 用户输入段边界——段前之表不越界
  }
  return null;
}

/**
 * 事件载荷防御性归一：事件级类型是宽 unknown（TodoWriteData），写侧经工具
 * schema 守门、但读侧可能面对异源会话——逐项校验形态，坏项丢弃不炸读。
 */
function normalizeItems(raw: readonly unknown[] | undefined): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { content, status, activeForm } = entry as Record<string, unknown>;
    if (typeof content !== 'string' || content === '') continue;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue;
    out.push({ content, status, ...(typeof activeForm === 'string' ? { activeForm } : {}) });
  }
  return out;
}

/* ---------------- 渲染：注入正文与回执 ---------------- */

/**
 * 全表文本（注入正文）。checkbox 形态对模型最友好；in_progress 行优先
 * activeForm（「正在做什么」比「要做什么」更贴当前态）。
 */
export function renderTodoTable(items: readonly TodoItem[]): string {
  return items
    .map((item) => {
      const marker = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
      const body = item.status === 'in_progress' && item.activeForm !== undefined ? item.activeForm : item.content;
      return `- ${marker} ${body}`;
    })
    .join('\n');
}

/**
 * 一行计数回执（tool/result 正文——dsh 式回执，上下文成本≈0）。
 * 空表走「已清空」文案（合法清空动作的显式确认）。
 */
export function buildTodoReceipt(items: readonly TodoItem[]): string {
  if (items.length === 0) return '已清空任务清单';
  const pending = items.filter((i) => i.status === 'pending').length;
  const inProgress = items.filter((i) => i.status === 'in_progress').length;
  const completed = items.filter((i) => i.status === 'completed').length;
  return `已更新任务清单：${items.length} 项（待办 ${pending} · 进行中 ${inProgress} · 完成 ${completed}）`;
}

/* ---------------- 工具件：todo（驱动域注册 def） ---------------- */

/** 写面（结构兼容 Session——窄面解耦，单测可造桩） */
export interface TodoWriteFace {
  /** 追加事件（Session.append 的窄签名） */
  append(type: 'todo/write', data: { items: readonly TodoItem[] }): SessionEvent;
}

/**
 * todo 工具 def（注册位在驱动 open——`tools.register(def, { driver: sessionId,
 * domain: appId })`，fs/bash 五件同款；本函数只出 def 不碰注册表）。
 *
 * schema 上限护栏（冷读裁决⑨）：maxItems 50 / 文本字段 maxLength 160——
 * 保守合计 < 64KiB 单事件护栏，超限在 schema 段拒绝（模型收窄重写），不落
 * 到 append 抛错。effect 'read'（goal 续跑轮按 read 类自动收留，裁决⑪）。
 */
export function createTodoTool(session: TodoWriteFace): ToolDefinition {
  return {
    name: 'todo',
    description:
      '维护当前任务清单（把多步工作拆成条目、边做边勾选）。每次调用全量替换整表（非增量）；条目粒度 2-8 项、单条一个可独立完成的小步；同刻只保持一项 in_progress，完成即标 completed；新用户消息后按需重建。整表会随后续每个请求回显（无需重读确认）。空数组 = 清空。',
    effect: 'read',
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          content: Type.String({ minLength: 1, maxLength: 160, description: '条目内容（祈使句短语）' }),
          status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')], {
            description: '状态三值',
          }),
          activeForm: Type.Optional(
            Type.String({ maxLength: 160, description: '进行中条目的现在进行时描述（in_progress 时建议携带）' }),
          ),
        }),
        { maxItems: 50, description: '整表全量替换（不是增量追加）' },
      ),
    }),
    execute: async (args: Record<string, unknown>, _ctx: ToolCtx): Promise<AgentToolResult> => {
      // 参数已经管道 schema 段守门；归一是事件读侧同款防御（双保险不涉信）
      const items = normalizeItems(args['items'] as readonly unknown[]);
      // durable 落账 = 唯一事实源（模型可见即落日志——回执与注入皆日志派生）
      session.append('todo/write', { items });
      return { content: [{ type: 'text', text: buildTodoReceipt(items) }] };
    },
  };
}

/* ---------------- 注入件：context_transform 瀑布 handler ---------------- */

/** 注册表窄面（结构兼容 DriverRegistry——只取 entries 查 Session） */
export interface TodoRegistryFace {
  /** sessionId → 驱动条目（条目暴露 session 即够——注入只读事件日志） */
  readonly entries: ReadonlyMap<string, { readonly session: Session }>;
}

/**
 * 注册 todo 注入件（件 apply 期调用一次；/reload 随锚回卷后 apply 重入即重挂）。
 *
 * - 角色注册（装载面，官方非特权）：render hidden = 不进时间线（瞬态注入非
 *   对话内容）；toLlm → user 消息（框架句 + 全表文本）。
 * - 瀑布 handler（S1 双参形状：sessionId 逐参透传 next，防单参兜底丢键）：
 *   registry miss（非对话会话）/ fold 空（run 首 turn）→ 原样放行；非空 →
 *   尾追注入块。handler 异常放行原请求（铁律 3 同款——todo 是增强不是循环
 *   的一拍，注入失败止步日志）。
 */
export function registerTodoInjection(ctx: AppContext, registry: TodoRegistryFace): void {
  ctx.registerMessageRole(TODO_ROLE, {
    toLlm: (message): UserMessage => ({
      role: 'user',
      content: String(message.content),
      // 信封字段（CustomMessage 类型必填）：= 注入物化时点，run 内即时投影
      // 不消费陈旧性语义（正文不带时间戳——骨架篇 §6.7 裁决④）
      timestamp: message.timestamp,
    }),
    render: { intent: 'hidden', label: '任务清单' },
  });
  ctx.effect(() =>
    ctx.on(
      'context_transform',
      async (messages: unknown, sessionId: unknown, next: (...args: unknown[]) => unknown) => {
        const list = Array.isArray(messages) ? messages : [];
        /** 原样放行（sessionId 逐参透传——S1 双参纪律） */
        const passthrough = (): unknown => next(messages, sessionId);
        try {
          const key = typeof sessionId === 'string' ? sessionId : undefined;
          const entry = key !== undefined ? registry.entries.get(key) : undefined;
          if (entry === undefined) return passthrough(); // 非本件会话（子代理/无驱动）——无 todo
          const items = foldCurrentTodo(entry.session.events);
          if (items === null || items.length === 0) return passthrough(); // 空表不注入（首 turn / 已清空）
          const injection = {
            role: TODO_ROLE,
            content: `${TODO_FRAME_SENTENCE}\n${renderTodoTable(items)}`,
            timestamp: Date.now(),
          };
          return next([...list, injection], sessionId);
        } catch (err) {
          // 铁律 3：注入失败放行原请求，止步日志（run 不为此失败）
          ctx.logger.error('todo 注入失败（放行原请求）', {
            error: err instanceof Error ? err.stack : String(err),
          });
          return passthrough();
        }
      },
    ),
  );
}
