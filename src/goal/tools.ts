/**
 * L3 goal — 工具三件（骨架篇 §6.8：模型面——目标内容在模型；第三十九批
 * T4-A 扩形：goalId 参数 + 轮结算形 + 证据账本；刀二：计划态投影摘要 +
 * open 项否决接线）。
 *
 * goal_get（状态投影 + 计划态摘要 + gates 状态 + 账本近尾摘录）/ goal_set
 * （设定目标+预算，激活锚 = 宿主日志长度）/ goal_update（判别三形：
 * completed 必附证据 + blocked 附原因——字段级 schema 约束（enum/minLength）
 * + execute 首部互斥判别双层执法（根 object 硬规则，顶层 union 会被 provider
 * 网关剥成空声明面——契约篇 §3.1，2026-08-31 全面复盘 #24）；**轮结算形**非终
 * 态可多次调用，每次落一条 goal/evidence durable 事件进证据账本）。
 * 转移合法性经 machine 判定，非法即响亮拒绝（GOAL_* 码）——宁拒绝不静默。
 */

import { Type } from '../contracts/typebox.js';
import {
  AppError,
  GOAL_ACTIVE_EXISTS,
  GOAL_TRANSITION_INVALID,
  GOAL_NOT_FOUND,
  TOOL_ARGUMENTS_INVALID,
} from '../contracts/errors.js';
import type { ToolDefinition, AgentToolResult } from '../contracts/tools.js';
import { canSetGoal, canUpdateGoal, DELIVERY_OUTCOMES } from './machine.js';
import type { GoalRecord } from './machine.js';
import type { TodoFoldItem } from './channel.js';
import { renderDisciplineClauses } from './prompts.js';
import type { GoalStore } from './store.js';

/**
 * sessions 服务最小面（本件消费：账本事件读写 + 日志长度——ctx.sessions 的
 * 结构子集，拓扑边不越界）。appendEvent 落**当前路由会话**（工具执行段内即
 * 归属会话）；eventsOfType 读内存活日志（与写同账零迟滞）；logLength = 激活
 * 锚取值口（宿主单源长度面——seq 连续性契约下长度即位置，checkpoint forkSeq
 * 同教训：词级过滤数组下标不得冒充全日志位置）。
 */
export interface GoalSessionsFace {
  appendEvent(type: string, data: unknown): unknown;
  /**
   * 读当前路由会话日志内指定类型事件（内存活日志——与写同账零迟滞）。
   * time = 事件信封毫秒时间戳（刀三唤醒窗口帽的时间维；goal/evidence 族
   * 事件无此消费可选）。
   */
  eventsOfType(type: string): Array<{ readonly data?: unknown; readonly time?: number }>;
  /** 当前路由会话日志长度（无路由落点 undefined——锚缺席诚实降级） */
  logLength(): number | undefined;
}

/** goal/evidence 轮结算账本载荷（T4-A——轮结算形写点） */
export interface GoalEvidencePayload {
  readonly goalId: string;
  readonly outcome: string;
  readonly evidence?: string;
  /** 轮身份（刀三接线：currentWakeId hook 缺席时如实缺席，账本不编造） */
  readonly wakeId?: string;
}

/**
 * 计划态快照（刀二——chat 件 todo fold 经组合根通道回流的计数面）：open =
 * 一切非 completed 状态项（deferred 含内——到窗复评是续跑提示义务非机器
 * 放行面）；gatedPassed = completed 且带 gate（完成即验过——执法在 todo
 * 执行段，此处只计数）。
 */
export interface TodoPlanSnapshot {
  /** 条目总数 */
  readonly total: number;
  /** 已完项 */
  readonly completed: number;
  /** 未完项（一切非 completed 状态——completed 申报机器否决的判据） */
  readonly open: number;
  /** 缓办项（open 子集——deferred） */
  readonly deferred: number;
  /** 声明 gate 的项数 */
  readonly gated: number;
  /** 已过 gate（completed 且带 gate） */
  readonly gatedPassed: number;
}

/** fold 条目 → 计数快照（纯函数——open = 非 completed） */
export function snapshotOfItems(items: readonly TodoFoldItem[]): TodoPlanSnapshot {
  let completed = 0;
  let deferred = 0;
  let gated = 0;
  let gatedPassed = 0;
  for (const item of items) {
    const isCompleted = item.status === 'completed';
    if (isCompleted) completed += 1;
    if (item.status === 'deferred') deferred += 1;
    if (item.gate !== undefined) {
      gated += 1;
      if (isCompleted) gatedPassed += 1;
    }
  }
  return { total: items.length, completed, open: items.length - completed, deferred, gated, gatedPassed };
}

/** 工具构造依赖（goal 应用 apply 期装配） */
export interface GoalToolsDeps {
  /** goals 表 DAO */
  readonly store: GoalStore;
  /** 当前会话 id 活取值（/new 热切换后自动跟新会话走） */
  readonly getSessionId: () => string | undefined;
  /** durable 事件面（账本读写 + 激活锚长度——ctx.sessions 窄面） */
  readonly sessions: GoalSessionsFace;
  /**
   * 计划态快照 hook（刀二接线：goalId → chat 件 goal-scoped fold 的计数面；
   * 经组合根通道回流）。undefined = 计划态面未接（chat 件未装载/无驱动条目），
   * open 项否决与 goal_get 计划态投影均诚实降级跳过。
   */
  readonly todoSnapshot?: (goalId: string) => TodoPlanSnapshot | undefined;
  /** 当前轮身份 hook（刀三接线：wakeId——轮结算账本归因） */
  readonly currentWakeId?: () => string | undefined;
  /**
   * 终态同笔回调（刀四 CR-6：goal_update 终态形执行段——settleDeclared 后
   * 由 apply 侧翻转挂钟行 enabled 位）。缺省不传 = 无挂钟面（诊断装配）。
   * 只在终态形（completed/blocked 落档）触发——active 轮结算不触发
   */
  readonly onTerminal?: (goalId: string) => void;
}

/** goal 行 → 人读投影文本（工具结果用——全字段如实示态，预算尽≠完成） */
function renderGoal(goal: GoalRecord): string {
  const lines = [
    `目标：${goal.objective}`,
    `身份：${goal.goalId}`,
    `状态：${goal.status}${goal.stopReason !== null ? `（原因：${goal.stopReason}）` : ''}`,
    `预算：已用 ${goal.tokensUsed} / ${goal.tokenBudget} tokens`,
    // 开洞申请如实示态（第二十四批题3a）：用户 /goal 面可见模型申报的写面需求
    `续跑工具面：${goal.needsWrite ? '已申报写面开洞（needsWrite——续跑轮全量工具）' : '只读收紧（read 类 + goal_get/goal_update）'}`,
  ];
  if (goal.evidence !== null) lines.push(`证据/原因：${goal.evidence}`);
  lines.push(`创建：${new Date(goal.createdAt).toISOString()}；更新：${new Date(goal.updatedAt).toISOString()}`);
  return lines.join('\n');
}

/**
 * 计划态投影段（刀二 §6.8 工具三件扩面：goal_get 含计划态投影摘要 + gates
 * 状态）：hook 缺席 = 面未接（chat 件未装载/无驱动条目）不渲染——诚实降级
 * 非编造空表。
 */
function renderPlanSnapshot(snapshot: TodoPlanSnapshot): string {
  const lines = [
    `计划态：共 ${snapshot.total} 项（未完 ${snapshot.open}${snapshot.deferred > 0 ? `，含缓办 ${snapshot.deferred}` : ''} · 已完 ${snapshot.completed}）`,
  ];
  if (snapshot.gated > 0) {
    lines.push(
      `判据门：${snapshot.gated} 项声明 gate（已过 ${snapshot.gatedPassed} / 待验 ${snapshot.gated - snapshot.gatedPassed}）`,
    );
  }
  return lines.join('\n');
}

/** 账本摘录行长度帽（近尾每条截断——投影是人读索引非全文复印） */
const LEDGER_EXCERPT_CHARS = 160;
/** 账本近尾摘录条数（streak / 审计看趋势够用——全量走 durable 日志） */
const LEDGER_TAIL_COUNT = 5;

/**
 * 证据账本近尾摘录（T4-A）：eventsOfType('goal/evidence') 按 goalId 过滤取
 * 近尾数条。读源 = 当前会话内存活日志（领养重绑前的历史轮账本在原会话日志，
 * 本面不跨会话拼——诚实边界，注释钉死防未来「静默漏读」误判为 bug）。
 * compaction surfaceOp 遮蔽不影响内存活日志读（账本两读归一之账本侧——冷读 CR-15）。
 */
function renderLedgerTail(deps: GoalToolsDeps, goalId: string): string {
  let entries: GoalEvidencePayload[] = [];
  try {
    entries = deps.sessions.eventsOfType('goal/evidence').flatMap((e) => {
      const data = e.data as GoalEvidencePayload | undefined;
      // 只收轮结算形（outcome 在场）——停因形（capped/stalls/budget，刀三）走
      // 状态行示态，混进序号摘录会渲染出 [undefined] 行
      return data !== undefined && data.goalId === goalId && data.outcome !== undefined ? [data] : [];
    });
  } catch {
    return ''; // eventsOfType 对未知词抛错——本件注册在先，理论不可达；静默降级保投影主面
  }
  if (entries.length === 0) return '';
  const tail = entries.slice(-LEDGER_TAIL_COUNT);
  const lines = tail.map((entry, i) => {
    const total = entries.length;
    const seq = total - tail.length + i + 1; // 账本内序号（1 起——按 durable seq 天然有序）
    const evidence = entry.evidence === undefined ? '' : `：${entry.evidence.slice(0, LEDGER_EXCERPT_CHARS)}`;
    return `${seq}. [${entry.outcome}]${evidence}`;
  });
  return [`证据账本（近 ${tail.length}/${entries.length} 条）：`, ...lines].join('\n');
}

/** 纯文本工具结果壳（与 memory 工具同款极简形态） */
function textResult(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** 构造工具三件（goal 应用注册进 ctx.tools——tools_change 原位刷新即模型可见） */
export function createGoalTools(deps: GoalToolsDeps): readonly ToolDefinition[] {
  /* ---------------- goal_get：goal 投影 + 证据账本近尾摘录 ---------------- */
  const goalGet: ToolDefinition = {
    name: 'goal_get',
    label: '查看目标',
    effect: 'read',
    description:
      '查看当前会话的长目标（goal）状态：目标内容、goalId、状态机档位（active/needs-resume/completed/blocked/stopped）、预算用量、申报证据、近尾轮结算账本。可带 goalId 查历史行（缺省当前会话 active 行）。无目标时如实报告无目标。',
    parameters: Type.Object({
      goalId: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 64,
          description: '目标身份（查历史行用；缺省 = 当前会话进行中的目标）',
        }),
      ),
    }),
    execute: async (args) => {
      let goal: GoalRecord | undefined;
      if (typeof args.goalId === 'string' && args.goalId !== '') {
        goal = deps.store.getByGoalId(args.goalId);
      } else {
        const sessionId = deps.getSessionId();
        goal = sessionId === undefined ? undefined : deps.store.getActiveBySession(sessionId);
        if (goal === undefined && sessionId !== undefined) goal = deps.store.getBySession(sessionId);
      }
      if (goal === undefined) {
        return textResult(
          typeof args.goalId === 'string' && args.goalId !== ''
            ? `没有 goalId 为 ${args.goalId} 的目标行。`
            : '当前会话没有设定目标（goal_set 可设定）。',
        );
      }
      const ledger = renderLedgerTail(deps, goal.goalId);
      // 计划态投影摘要（刀二）：active 行才查（终态行无进行中计划态）；
      // hook 缺席 = 面未接不渲染
      const plan =
        goal.status === 'active' && deps.todoSnapshot !== undefined ? deps.todoSnapshot(goal.goalId) : undefined;
      const planLine = plan === undefined ? '' : renderPlanSnapshot(plan);
      return textResult([renderGoal(goal), planLine, ledger].filter((section) => section !== '').join('\n'));
    },
  };

  /* ---------------- goal_set：设定目标 + 预算（active 行占位即拒） ---------------- */
  const goalSet: ToolDefinition = {
    name: 'goal_set',
    label: '设定目标',
    effect: 'write',
    description: [
      '为当前会话设定一个长目标（goal）：此后每轮结算若目标未完成且预算未尽，将自动注入续跑提示推进目标，直到申报完成/阻塞或预算耗尽。',
      '目标应当具体可验证（完成后能逐需求给出证据）。tokenBudget 是本目标的 token 预算帽（主循环全部花销累计），耗尽即刹停并要求收尾。',
      '运行纪律（申报终态前自查）：',
      renderDisciplineClauses(),
    ].join('\n'),
    parameters: Type.Object({
      objective: Type.String({
        minLength: 1,
        maxLength: 2000,
        description: '目标内容（具体、可验证——完成后逐需求给证据）',
      }),
      tokenBudget: Type.Integer({
        minimum: 1000,
        maximum: 100_000_000,
        description: '目标 token 预算帽（主循环累计；耗尽即刹停收尾，不等于完成）',
      }),
      needsWrite: Type.Optional(
        Type.Boolean({
          description:
            '写面开洞申请：目标需要写文件/执行命令时显式申报 true（用户 /goal 面可见）——续跑轮获得全量工具；缺省 false = 无人值守续跑轮只读（检索/阅读类可用），靠读做不到时再申报重设',
        }),
      ),
    }),
    execute: async (args) => {
      const sessionId = deps.getSessionId();
      if (sessionId === undefined) return textResult('无会话上下文（persist:false 或未建立会话）——goal 不可用。', true);
      const objective = String(args.objective);
      const tokenBudget = Number(args.tokenBudget);
      const needsWrite = args.needsWrite === true;
      const current = deps.store.getBySession(sessionId);
      // active 行占位即拒（一径：先 goal_update 申报终态或 /goal stop，再重设）
      if (!canSetGoal(current)) {
        throw new AppError(
          GOAL_ACTIVE_EXISTS,
          '当前会话已有进行中的目标（active）——先完成/停止当前目标（goal_update 或 /goal stop）再设定新目标',
        );
      }
      const now = Date.now();
      // v13 重设 = 新 goalId 新行（终态行留史不覆盖）；激活锚 = 宿主日志长度
      // （刀二接线：sessions.logLength 单源——goal-scoped fold 从激活点折叠，
      // 无路由落点 null = 锚缺席诚实降级）
      const anchor = deps.sessions.logLength();
      const goal = deps.store.setActive(sessionId, objective, tokenBudget, needsWrite, now, anchor ?? null);
      // 有旧行（终态/降级）即注明留史——重设从「覆盖」改「新行留史」的如实示态
      const replaced = current !== undefined ? `（新 goalId ${goal.goalId}——旧 ${current.status} 行留史）` : '';
      return textResult(`目标已设定并激活${replaced}。\n${renderGoal(goal)}`);
    },
  };

  /* ---------------- goal_update：判别三形（字段级 schema + execute 判别执法 + 账本写点） ---------------- */
  const goalUpdate: ToolDefinition = {
    name: 'goal_update',
    label: '申报目标',
    effect: 'write',
    description: [
      '申报当前目标的状态。两形终态：completed = 目标已达成——必须附分级证据（可复现验证 > 工具输出摘录 > 口头断言），任何需求只有口头断言 = 未完成不许申报，且目标计划态存在未完项（open = 一切非 completed 状态项）时机器否决；blocked = 连续 3 个 goal 轮次卡同一阻塞——附原因与已尝试的办法。',
      '轮结算形（非终态、每轮 run 结束应调用一次）：outcome 四值——surface_only（只完成表面动作，无实质推进）/ outcome_gap（尝试修改结果但没生效）/ outcome_progress（实质推进但目标未完成）/ primary_goal_outcome（目标本身的结果已交付）。outcome 是机器判定信号（喂反空转与预算有效性），虚报与反缩水条款同罪；evidence 可选附摘录。',
      '终态申报后目标定格（可用 goal_set 重设新目标）；轮结算不改变目标状态。',
    ].join('\n'),
    // 声明面 = 扁平 object（根 object 硬规则——契约篇 §3.1，2026-08-31 全面复盘
    // #24 修死）：顶层 union（anyOf 根无 type 字段）会被 provider 网关剥成空声明
    // 面（真跑 9 连败实证——模型只见不可用 schema、以空参数 {} 调用、宿主 root
    // 级拒绝）。三形互斥执法位移到 execute 首部判别（见下）；字段级约束
    // （enum 收口 / minLength）仍由 schema 段执管——执法强度不变
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union([Type.Literal('completed'), Type.Literal('blocked')], {
          description: '终态判别字段（与 outcome 互斥）：completed = 目标达成 / blocked = 连续 3 轮同一阻塞',
        }),
      ),
      evidence: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 8000,
          description: '完成证据（status=completed 必附；逐需求列出并分级：可复现验证/工具输出摘录/口头断言）',
        }),
      ),
      note: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 4000,
          description: '阻塞原因（status=blocked 必附；含已尝试的办法——须连续 3 轮同一阻塞）',
        }),
      ),
      outcome: Type.Optional(
        Type.Union(
          DELIVERY_OUTCOMES.map((v) => Type.Literal(v)),
          {
            description:
              '轮结算判别字段（与 status 互斥；非终态、每轮 run 结束应调用一次）：surface_only / outcome_gap / outcome_progress / primary_goal_outcome——机器判定信号，如实申报',
          },
        ),
      ),
    }),
    execute: async (args) => {
      // 判别执法位（三形互斥——schema 段管字段级类型，互斥在此）：参数问题优先
      // 于目标状态问题（与三段管道分工同构）。指引文案带三形全貌——模型拿到可
      // 行动回执才能自纠（空 schema 时代模型只会重复 {}）
      const hasStatus = args.status !== undefined;
      const hasOutcome = args.outcome !== undefined;
      if (hasStatus === hasOutcome) {
        // 同缺（空参数——真跑 9 连败形状）或同携（歧义）都拒
        throw new AppError(
          TOOL_ARGUMENTS_INVALID,
          hasStatus
            ? 'goal_update 参数非法：status（终态形）与 outcome（轮结算形）互斥——一次申报只择一形'
            : 'goal_update 参数需三形择一：① 终态 status=completed 附 evidence（完成证据，逐需求分级）；' +
                '② 终态 status=blocked 附 note（阻塞原因与已尝试的办法）；' +
                `③ 轮结算 outcome 四值（${DELIVERY_OUTCOMES.join(' / ')}）可附 evidence 摘录——status 与 outcome 互斥`,
        );
      }
      if (args.status === 'completed' && args.evidence === undefined) {
        throw new AppError(
          TOOL_ARGUMENTS_INVALID,
          '终态形 status=completed 必附 evidence（完成证据：逐需求列出并分级——可复现验证 > 工具输出摘录 > 口头断言）',
        );
      }
      if (args.status === 'blocked' && args.note === undefined) {
        throw new AppError(
          TOOL_ARGUMENTS_INVALID,
          '终态形 status=blocked 必附 note（阻塞原因——含已尝试的办法，须连续 3 轮同一阻塞）',
        );
      }
      const sessionId = deps.getSessionId();
      if (sessionId === undefined) return textResult('无会话上下文——goal 不可用。', true);
      // 当前行读取（active 优先排序）：无行 NOT_FOUND / 有行非 active TRANSITION_INVALID
      // 两码分立（getBySession 单读两用——排序保证 active 行在场时恒命中）
      const current = deps.store.getBySession(sessionId);
      if (current === undefined) {
        throw new AppError(GOAL_NOT_FOUND, '当前会话没有设定目标（goal_set 先设定）');
      }
      if (!canUpdateGoal(current)) {
        throw new AppError(
          GOAL_TRANSITION_INVALID,
          `目标当前为 ${current.status}——只有 active 态可申报（needs-resume 态先 /goal resume 重新授权）`,
        );
      }
      const now = Date.now();

      /* ---- 轮结算形：落 goal/evidence 账本事件，不动状态行 ---- */
      if (args.status === undefined) {
        const req = args as { outcome: string; evidence?: string };
        // wakeId 刀三接线：hook 缺席或返回 undefined（非 goal 唤醒轮——无归因）
        // 都如实缺席——条件展开按**值**不按 hook 在场性（undefined 字段进 durable
        // 载荷会被事件校验段拒绝：展开对象携带未定义字段）
        const wakeId = deps.currentWakeId?.();
        const payload: GoalEvidencePayload = {
          goalId: current.goalId,
          outcome: req.outcome,
          ...(wakeId !== undefined ? { wakeId } : {}),
          ...(req.evidence !== undefined ? { evidence: req.evidence } : {}),
        };
        deps.sessions.appendEvent('goal/evidence', payload);
        return textResult(`轮结算已入账（${req.outcome}）——目标保持 active。\n${renderGoal(current)}`);
      }

      /* ---- 终态形：completed 机器否决（open 项）→ 结算 ---- */
      const req = args as { status: 'completed' | 'blocked'; evidence?: string; note?: string };
      if (req.status === 'completed') {
        // open 项否决（T2-A「完成由 todo 前沿涌现」执法位）：hook 未接
        //（chat 件未装载/无驱动条目）= 计划态面缺席，降级跳过——诚实降级
        // 非编造空表；接线后即机器执法
        const snapshot = deps.todoSnapshot?.(current.goalId);
        if (snapshot !== undefined && snapshot.open > 0) {
          throw new AppError(
            GOAL_TRANSITION_INVALID,
            `计划态存在 ${snapshot.open} 个未完项（open = 一切非 completed 状态项，deferred 含内）——完成由 todo 前沿涌现：先收尾未完项或逐项申报理由`,
          );
        }
      }
      const evidence = req.status === 'completed' ? String(req.evidence) : String(req.note);
      deps.store.settleDeclared(current.goalId, req.status, evidence, now);
      // 终态同笔停摆挂钟（刀四 CR-6）：行落终态即钟行翻转 enabled=0——apply
      // 侧闭包接线（面缺席/无钟静默 no-op）
      deps.onTerminal?.(current.goalId);
      const goal = deps.store.getByGoalId(current.goalId)!;
      return textResult(`终态已落档（${req.status}）。\n${renderGoal(goal)}`);
    },
  };

  return [goalGet, goalSet, goalUpdate];
}
