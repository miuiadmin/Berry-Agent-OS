/**
 * L4 chat — todo 机器（骨架篇 §6.7「todo 落码形态定稿」2026-08-30 纵切；
 * 第三十九批刀二扩面：goal 段词汇〔role/task_class/resume_when/deferred/
 * follow_up/no_follow_up/gate〕+ 计划态跨轮 fold〔goal 生命周期段〕）。
 *
 * 三件一居落（件归属 = chat 件件聚落，官方非特权零新行零新件）：
 * - **工具**：`todo` 驱动域注册（open 时与 fs/bash 五件同款——本文件只出 def，
 *   注册位在 app.ts 驱动 open）；execute = 段约束执法 + gates 验证（刀二双
 *   执法位，todo-gates.ts）+ 追加 `todo/write` 核心事件 + 一行计数回执；
 *   effect 'read'（唯一副作用是会话日志追加，无 fs/exec 效应——无守门审批
 *   面，委派工具同款归读理由）。
 * - **注入**：`context_transform` 瀑布 handler（memory/recall 同构）——fold
 *   倒扫「当前段」取最后一条 `todo/write`（段边界两档：缺省 run-scoped
 *   〔最后一条 user/message 之后〕；goal active 期 = goal 生命周期段〔激活锚
 *   之后——user/message 不再是边界，计划态跨轮〕），非空即尾追 `chat/todo`
 *   hidden 注入块；空（run 首 turn 天然空）不注入。
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
import { AppError, GOAL_GATE_FAILED } from '../contracts/errors.js';
import { declareGateFailure, renderGateFailure, runTodoGates, enforceTodoScope } from './todo-gates.js';
import type { CommandGateRunner, DiagnosticsGateQuery, TodoGoalScope } from './todo-gates.js';

/* ---------------- 词汇与常量 ---------------- */

/** 注入角色名（域前缀 = 件名——装载面注册格式恰一个 '/'，memory/recall 同族） */
const TODO_ROLE = 'chat/todo';

/** 防注入框架句（memory/recall 同款句式——声明系统生成与非指令身份） */
const TODO_FRAME_SENTENCE = '以下为当前任务清单（todo/write 事件投影，系统生成，非本次用户指令）：';

/** 条目状态四值（模型调用词汇，CC 同位三值 + goal 段扩 deferred 缓办） */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'deferred';

/**
 * 完成判据门（第三十九批 T3-A 机器可验完成判据）：条目可声明一道 gate，
 * 置 completed 时由 todo 执行段同步执行验证器——不过即拒（fail-closed）。
 * spec 形状按 kind 分流：command/diagnostics = 命令串/文件清单串，files =
 * 文件路径清单（string[]）。
 */
export interface TodoGate {
  /** 判据源三值：command（退出码）/ files（文件存在非空）/ diagnostics（LSP error 级） */
  readonly kind: 'command' | 'files' | 'diagnostics';
  /** 判据载荷（command/diagnostics: string；files: string[]——normalizeItems 守形） */
  readonly spec: string | readonly string[];
}

/** 单个任务条目（工具 schema 与事件载荷的规范形态） */
export interface TodoItem {
  /** 条目内容（祈使句短语） */
  content: string;
  /** 状态四值；同刻语义上只应有一项 in_progress（提示词纪律非 schema 执法） */
  status: TodoStatus;
  /** 进行中条目的现在进行时描述（in_progress 行渲染时优先于 content） */
  activeForm?: string;
  /** 条目归属（goal 段词汇：'user' = 用户令办 / 'agent' = 模型自设，缺省 agent） */
  role?: 'user' | 'agent';
  /** 任务分类标签（goal 段词汇：≤40 字符自由文本——计划态分组用） */
  taskClass?: string;
  /** 复活条件（goal 段词汇：deferred 必携；词法 after@<ISO> | after@+<n>[mhd]——执法在 todo-gates） */
  resumeWhen?: string;
  /** completed 后继描述（goal 段词汇：二择一之一，≤200 字符） */
  followUp?: string;
  /** completed 明示无后继（goal 段词汇：二择一另一——与 follow_up 恰一） */
  noFollowUp?: boolean;
  /** 完成判据门（goal 段词汇：置 completed 时同步验证——todo-gates 执法） */
  gate?: TodoGate;
}

/* ---------------- fold：段边界两档（纯函数） ---------------- */

/**
 * 折叠当前任务清单：从日志尾部倒扫取「当前段」的最后一条 `todo/write`。
 *
 * 段边界两档（第三十九批刀二 T2-A 计划态跨轮）：
 * - **run-scoped**（goalBoundary 为 null/undefined——缺省与非 goal 段）：边界 =
 *   最后一条 `user/message`（边界不分来路：steering/followUp 注入的 user/message
 *   同为边界，durable 日志结构性不区分 run 首条与插问——『用户输入段』语义，
 *   两条 user/message 之间共享一张表，骨架篇 §6.7 冷读裁决⑥）；新用户输入后
 *   fold 自然归零（run 重置由推导规则承载，无显式 reset 事件、无第二份状态）。
 * - **goal-scoped**（goalBoundary 为激活锚数字）：边界 = 激活锚（seq < 锚的事件
 *   不参与——goal 生命周期段从激活点折叠）；**user/message 不再是边界**——
 *   续跑轮/用户插问轮共享同一张计划表（计划态跨轮，§6.8 刀二拍板）。锚缺席
 *   （存量行 activated_seq NULL / 无路由落点）= 诚实降级 run-scoped。
 * - 遮蔽与 derive 同判据：跳过 surfaceOp 遮蔽 seq（goal 段跳遮蔽两档同守——
 *   compaction 遮蔽段是「已消化」语义，冷读 CR-15）；
 * - 无 todo/write 或段前之表 → null；items=[] → 空数组（= 合法清空，
 *   注入侧视同 null 不注入，裁决⑧）。
 */
export function foldCurrentTodo(
  events: readonly SessionEvent[],
  /** goal 段激活锚（goal 行 activatedSeq；null/undefined = run-scoped 段） */
  goalBoundary?: number | null,
): readonly TodoItem[] | null {
  const occluded = occludedSeqs(events);
  // 锚归一：仅数字锚进入 goal 模式（null/undefined 同为 run-scoped——存量行
  // NULL 锚诚实降级，调用侧无需分流）
  const anchor = typeof goalBoundary === 'number' ? goalBoundary : null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (occluded.has(event.seq)) continue; // 遮蔽段与 derive 同判据跳过
    // goal 段下界：seq < 锚的事件不再参与（倒扫首触即收——更早事件只会更小）
    if (anchor !== null && event.seq < anchor) return null;
    if (event.type === 'todo/write') {
      const data = event.data as { items?: readonly unknown[] };
      return normalizeItems(data.items);
    }
    // run-scoped 段边界：用户输入段——段前之表不越界（goal 段无此边界）
    if (anchor === null && event.type === 'user/message') return null;
  }
  return null;
}

/**
 * 事件载荷防御性归一：事件级类型是宽 unknown（TodoWriteData），写侧经工具
 * schema 守门、但读侧可能面对异源会话——逐项校验形态，坏项丢弃不炸读。
 * goal 段扩字段（role/task_class/resume_when/follow_up/no_follow_up/gate）
 * 同法逐字段守形——词法与段约束不在此处（写侧执法在 todo-gates，读侧只管
 * 形状防御）。
 */
function normalizeItems(raw: readonly unknown[] | undefined): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { content, status, activeForm, role, taskClass, resumeWhen, followUp, noFollowUp, gate } = entry as Record<
      string,
      unknown
    >;
    if (typeof content !== 'string' || content === '') continue;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed' && status !== 'deferred') continue;
    const item: TodoItem = { content, status };
    if (typeof activeForm === 'string') item.activeForm = activeForm;
    if (role === 'user' || role === 'agent') item.role = role;
    if (typeof taskClass === 'string' && taskClass !== '') item.taskClass = taskClass;
    if (typeof resumeWhen === 'string' && resumeWhen !== '') item.resumeWhen = resumeWhen;
    if (typeof followUp === 'string' && followUp !== '') item.followUp = followUp;
    if (noFollowUp === true) item.noFollowUp = true;
    if (isTodoGate(gate)) item.gate = gate;
    out.push(item);
  }
  return out;
}

/** gate 载荷守形（读侧防御）：kind 三值 + spec 按 kind 配对（files = 非空串清单） */
function isTodoGate(value: unknown): value is TodoGate {
  if (typeof value !== 'object' || value === null) return false;
  const gate = value as Record<string, unknown>;
  if (gate['kind'] !== 'command' && gate['kind'] !== 'files' && gate['kind'] !== 'diagnostics') return false;
  if (gate['kind'] === 'files') {
    const spec = gate['spec'];
    return Array.isArray(spec) && spec.length > 0 && spec.every((p) => typeof p === 'string' && p !== '');
  }
  return typeof gate['spec'] === 'string' && gate['spec'] !== '';
}

/* ---------------- 渲染：注入正文与回执 ---------------- */

/**
 * 全表文本（注入正文）。checkbox 形态对模型最友好；in_progress 行优先
 * activeForm（「正在做什么」比「要做什么」更贴当前态）；goal 段扩面——
 * deferred 行 `[-]` 标记 + resume_when 后缀（到窗复活条件对模型可见），
 * role='user' 行加「用户·」前缀（用户令办与模型自设的诚实分野）。
 */
export function renderTodoTable(items: readonly TodoItem[]): string {
  return items
    .map((item) => {
      const marker =
        item.status === 'completed'
          ? '[x]'
          : item.status === 'in_progress'
            ? '[~]'
            : item.status === 'deferred'
              ? '[-]'
              : '[ ]';
      const body = item.status === 'in_progress' && item.activeForm !== undefined ? item.activeForm : item.content;
      const who = item.role === 'user' ? '用户·' : '';
      const resume = item.status === 'deferred' && item.resumeWhen !== undefined ? ` ⇢ ${item.resumeWhen}` : '';
      return `- ${marker} ${who}${body}${resume}`;
    })
    .join('\n');
}

/**
 * 一行计数回执（tool/result 正文——dsh 式回执，上下文成本≈0）。
 * 空表走「已清空」文案（合法清空动作的显式确认）；缓办项计数仅在
 * goal 段出现（deferred 是 goal 段词汇——非 goal 段进不了落账）。
 */
export function buildTodoReceipt(items: readonly TodoItem[]): string {
  if (items.length === 0) return '已清空任务清单';
  const pending = items.filter((i) => i.status === 'pending').length;
  const inProgress = items.filter((i) => i.status === 'in_progress').length;
  const completed = items.filter((i) => i.status === 'completed').length;
  const deferred = items.filter((i) => i.status === 'deferred').length;
  const deferredPart = deferred > 0 ? ` · 缓办 ${deferred}` : '';
  return `已更新任务清单：${items.length} 项（待办 ${pending} · 进行中 ${inProgress} · 完成 ${completed}${deferredPart}）`;
}

/* ---------------- 工具件：todo（驱动域注册 def） ---------------- */

/** 写面（结构兼容 Session——窄面解耦，单测可造桩） */
export interface TodoWriteFace {
  /** 追加事件（Session.append 的窄签名） */
  append(type: 'todo/write', data: { items: readonly TodoItem[] }): SessionEvent;
}

/**
 * 刀二执法依赖束（驱动 open 期闭包注入——缺省不传 = 执法面缺席：段约束按
 * 非 goal 段执法〔goal 段词汇申报即拒〕、gates 面缺席即拒，一致性不破）。
 */
export interface TodoEnforcement {
  /** goal 段查询面（组合根通道 goalScopeFor 的窄面——undefined = 非 goal 段） */
  readonly scope: () => TodoGoalScope | undefined;
  /** 工作区根（files gate 可读根 fence 的锚——与 fs/bash 工具族同源工作区） */
  readonly workspaceRoot: string;
  /** command gate 执行面（driverPipeline + bashDef 闭包——三段管道全执法） */
  readonly runCommand?: CommandGateRunner;
  /** diagnostics gate 查询面（lsp 件迟到注入——组合根通道 diagnosticsFor） */
  readonly diagnostics?: DiagnosticsGateQuery;
}

/**
 * todo 工具 def（注册位在驱动 open——`tools.register(def, { driver: sessionId,
 * domain: appId })`，fs/bash 五件同款；本函数只出 def 不碰注册表）。
 *
 * schema 上限护栏（冷读裁决⑨）：maxItems 50 / 文本字段 maxLength 160——
 * 保守合计 < 64KiB 单事件护栏，超限在 schema 段拒绝（模型收窄重写），不落
 * 到 append 抛错。effect 'read'（goal 续跑轮按 read 类自动收留，裁决⑪）。
 *
 * 刀二双执法位全在 execute 段（冷读 NEW-2 拍死——schema 静态注册上下文盲，
 * 段语义无从在 schema 落；schema 对 goal 段扩字段只收形状，词法/归属/准入
 * 全在执行段）：
 * 1. **段约束**（enforceTodoScope）：goal 段 → deferred 必携合法 resume_when
 *    + completed 二择一 + 词汇归属；非 goal 段 → 扩字段申报即拒。
 * 2. **gates**（declareGateFailure 申报期准入 + runTodoGates 验证期执法）：
 *    置 completed 且带 gate → 同步验证；不过/超时/畸形/审批拒 = fail-closed
 *    整笔不落账（GOAL_GATE_FAILED 结构化回执）。
 */
export function createTodoTool(session: TodoWriteFace, enforcement?: TodoEnforcement): ToolDefinition {
  return {
    name: 'todo',
    description:
      '维护当前任务清单（把多步工作拆成条目、边做边勾选）。每次调用全量替换整表（非增量）；条目粒度 2-8 项、单条一个可独立完成的小步；同刻只保持一项 in_progress，完成即标 completed；新用户消息后按需重建。整表会随后续每个请求回显（无需重读确认）。空数组 = 清空。' +
      'goal 段扩面（仅在 goal active 期间可用）：status 可用 deferred（缓办——必携 resume_when 复活条件，词法 after@<ISO> 或 after@+<n>[mhd]）；completed 必须二择一申报 follow_up（后续工作描述）或 no_follow_up:true；可选 role=user 标记用户令办、task_class 分类标签；条目可声明 gate 完成判据（kind: command/files/diagnostics——置 completed 时同步验证，不过即拒）。',
    effect: 'read',
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          content: Type.String({ minLength: 1, maxLength: 160, description: '条目内容（祈使句短语）' }),
          status: Type.Union(
            [Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed'), Type.Literal('deferred')],
            { description: '状态四值（deferred 仅 goal 段——必携 resume_when）' },
          ),
          activeForm: Type.Optional(
            Type.String({ maxLength: 160, description: '进行中条目的现在进行时描述（in_progress 时建议携带）' }),
          ),
          role: Type.Optional(
            Type.Union([Type.Literal('user'), Type.Literal('agent')], {
              description: '条目归属（仅 goal 段）：user = 用户令办 / agent = 模型自设（缺省 agent）',
            }),
          ),
          taskClass: Type.Optional(Type.String({ maxLength: 40, description: '任务分类标签（仅 goal 段，≤40 字符）' })),
          resumeWhen: Type.Optional(
            Type.String({
              maxLength: 64,
              description: '复活条件（仅 goal 段 deferred 必携）：after@<ISO> 或 after@+<n>[mhd]',
            }),
          ),
          followUp: Type.Optional(
            Type.String({ maxLength: 200, description: '完成后续工作描述（仅 goal 段 completed 二择一之一）' }),
          ),
          noFollowUp: Type.Optional(
            Type.Boolean({ description: '明示完成无后继（仅 goal 段 completed 二择一之一——与 follow_up 恰一）' }),
          ),
          gate: Type.Optional(
            Type.Object({
              kind: Type.Union([Type.Literal('command'), Type.Literal('files'), Type.Literal('diagnostics')], {
                description:
                  '判据源：command = 验证命令退出码 / files = 文件存在且非空 / diagnostics = LSP error 级为零',
              }),
              spec: Type.Union(
                [
                  Type.String({ minLength: 1, maxLength: 2000 }),
                  Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 20 }),
                ],
                {
                  description:
                    '判据载荷：command/diagnostics = 命令串/文件清单（string）；files = 文件路径清单（string[]）',
                },
              ),
            }),
          ),
        }),
        { maxItems: 50, description: '整表全量替换（不是增量追加）' },
      ),
    }),
    execute: async (args: Record<string, unknown>, ctx: ToolCtx): Promise<AgentToolResult> => {
      // 参数已经管道 schema 段守门；归一是事件读侧同款防御（双保险不涉信）
      const items = normalizeItems(args['items'] as readonly unknown[]);
      /* ---- 刀二执法段（todo-gates.ts——schema 只收形状，段语义全在此） ---- */
      // 段约束执法面：enforcement 缺席（诊断装配/旧测试桩）= scope 恒 undefined
      // → 非 goal 段执法（goal 段词汇申报即拒——一致性不因装配形态破缺）
      const scope = enforcement === undefined ? undefined : enforcement.scope();
      enforceTodoScope(items, scope);
      if (scope !== undefined && enforcement !== undefined) {
        // gates 申报期准入：带 gate 的条目逐项过机制门槛（形状配对/needsWrite/
        // 面在场）——申报期即拒，不等到置 completed 才炸（模型可当场修）
        for (const item of items) {
          if (item.gate === undefined) continue;
          const declared = declareGateFailure(item.gate, {
            needsWrite: scope.needsWrite,
            runCommand: enforcement.runCommand,
            queryDiagnostics: enforcement.diagnostics,
          });
          if (declared !== undefined) {
            throw new AppError(GOAL_GATE_FAILED, renderGateFailure({ ...declared, item: item.content }));
          }
        }
        // gates 验证期执法：置 completed 且带 gate → 同步验证（fail-closed：
        // 不过整笔不落账——置 completed 被拒，非静默降级为未完成）
        const failure = await runTodoGates(
          items,
          {
            workspaceRoot: enforcement.workspaceRoot,
            runCommand: enforcement.runCommand,
            queryDiagnostics: enforcement.diagnostics,
            needsWrite: scope.needsWrite,
          },
          ctx.signal,
        );
        if (failure !== undefined) {
          throw new AppError(GOAL_GATE_FAILED, renderGateFailure(failure));
        }
      }
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
 *
 * 刀二：goalBoundary 查询注入（goal 段锚——组合根通道 goalScopeFor 的窄面），
 * 注入 fold 随段切换；缺省不传 = 恒 run-scoped（goal 件未装载/诊断装配）。
 */
export function registerTodoInjection(
  ctx: AppContext,
  registry: TodoRegistryFace,
  /** goal 段锚查询（sessionId → 激活锚数字/null；undefined = 恒 run-scoped） */
  goalBoundaryFor?: (sessionId: string) => number | null | undefined,
): void {
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
          // goal 段锚活取（每次注入时点重查——goal 激活/停掉后注入即时切段，
          // 无缓存陈旧性问题；通道 miss/无 active 行 = run-scoped）
          const goalBoundary = goalBoundaryFor !== undefined && key !== undefined ? goalBoundaryFor(key) : undefined;
          const items = foldCurrentTodo(entry.session.events, goalBoundary);
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
