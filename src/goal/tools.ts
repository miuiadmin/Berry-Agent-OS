/**
 * L3 goal — 工具三件（骨架篇 §6.8：模型面——目标内容在模型；第三十九批
 * T4-A 扩形：goalId 参数 + 轮结算形 + 证据账本）。
 *
 * goal_get（状态投影 + 账本近尾摘录）/ goal_set（设定目标+预算）/ goal_update
 * （union 三形：completed 必附证据 + blocked 附原因是 schema 执法位——union
 * 分支逐字面绑定必填字段，参数校验段即拦截不靠提示词自觉；**轮结算形**
 * 非终态可多次调用，每次落一条 goal/evidence durable 事件进证据账本）。
 * 转移合法性经 machine 判定，非法即响亮拒绝（GOAL_* 码）——宁拒绝不静默。
 */

import { Type } from '../contracts/typebox.js';
import { AppError, GOAL_ACTIVE_EXISTS, GOAL_TRANSITION_INVALID, GOAL_NOT_FOUND } from '../contracts/errors.js';
import type { ToolDefinition, AgentToolResult } from '../contracts/tools.js';
import { canSetGoal, canUpdateGoal, DELIVERY_OUTCOMES } from './machine.js';
import type { GoalRecord } from './machine.js';
import { renderDisciplineClauses } from './prompts.js';
import type { GoalStore } from './store.js';

/**
 * sessions 服务最小面（本件消费：账本事件读写——ctx.sessions 的结构子集，
 * 拓扑边不越界）。appendEvent 落**当前路由会话**（工具执行段内即归属会话）；
 * eventsOfType 读内存活日志（与写同账零迟滞）。
 */
export interface GoalSessionsFace {
  appendEvent(type: string, data: unknown): unknown;
  eventsOfType(type: string): Array<{ readonly data?: unknown }>;
}

/** goal/evidence 轮结算账本载荷（T4-A——轮结算形写点） */
export interface GoalEvidencePayload {
  readonly goalId: string;
  readonly outcome: string;
  readonly evidence?: string;
  /** 轮身份（刀三接线：currentWakeId hook 缺席时如实缺席，账本不编造） */
  readonly wakeId?: string;
}

/** 工具构造依赖（goal 应用 apply 期装配） */
export interface GoalToolsDeps {
  /** goals 表 DAO */
  readonly store: GoalStore;
  /** 当前会话 id 活取值（/new 热切换后自动跟新会话走） */
  readonly getSessionId: () => string | undefined;
  /** durable 事件面（账本读写——ctx.sessions 窄面） */
  readonly sessions: GoalSessionsFace;
  /**
   * open 项计数 hook（刀二接线：goal-scoped 计划态的未完项——open = 一切
   * 非 completed 状态项）。undefined = 计划态面未接（批内刀序诚实过渡），
   * completed 申报机器否决降级跳过。
   */
  readonly countOpenItems?: (goalId: string) => number | undefined;
  /** 当前轮身份 hook（刀三接线：wakeId——轮结算账本归因） */
  readonly currentWakeId?: () => string | undefined;
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
      return data !== undefined && data.goalId === goalId ? [data] : [];
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
      return textResult(ledger === '' ? renderGoal(goal) : `${renderGoal(goal)}\n${ledger}`);
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
      // v13 重设 = 新 goalId 新行（终态行留史不覆盖）；activatedSeq 第二刀接线填宿主日志长度
      const goal = deps.store.setActive(sessionId, objective, tokenBudget, needsWrite, now);
      // 有旧行（终态/降级）即注明留史——重设从「覆盖」改「新行留史」的如实示态
      const replaced = current !== undefined ? `（新 goalId ${goal.goalId}——旧 ${current.status} 行留史）` : '';
      return textResult(`目标已设定并激活${replaced}。\n${renderGoal(goal)}`);
    },
  };

  /* ---------------- goal_update：union 三形（schema 执法位 + 账本写点） ---------------- */
  const goalUpdate: ToolDefinition = {
    name: 'goal_update',
    label: '申报目标',
    effect: 'write',
    description: [
      '申报当前目标的状态。两形终态：completed = 目标已达成——必须附分级证据（可复现验证 > 工具输出摘录 > 口头断言），任何需求只有口头断言 = 未完成不许申报，且目标计划态存在未完项（open = 一切非 completed 状态项）时机器否决；blocked = 连续 3 个 goal 轮次卡同一阻塞——附原因与已尝试的办法。',
      '轮结算形（非终态、每轮 run 结束应调用一次）：outcome 四值——surface_only（只完成表面动作，无实质推进）/ outcome_gap（尝试修改结果但没生效）/ outcome_progress（实质推进但目标未完成）/ primary_goal_outcome（目标本身的结果已交付）。outcome 是机器判定信号（喂反空转与预算有效性），虚报与反缩水条款同罪；evidence 可选附摘录。',
      '终态申报后目标定格（可用 goal_set 重设新目标）；轮结算不改变目标状态。',
    ].join('\n'),
    // union 分支绑定必填字段：completed 无 evidence / blocked 无 note 过不了参数校验段；
    // 轮结算形无 status 字段（outcome 字段即判别）——三形互斥自然分流
    parameters: Type.Union([
      Type.Object({
        status: Type.Literal('completed'),
        evidence: Type.String({
          minLength: 1,
          maxLength: 8000,
          description: '完成证据（逐需求列出并分级：可复现验证/工具输出摘录/口头断言）',
        }),
      }),
      Type.Object({
        status: Type.Literal('blocked'),
        note: Type.String({
          minLength: 1,
          maxLength: 4000,
          description: '阻塞原因（含已尝试的办法——须连续 3 轮同一阻塞）',
        }),
      }),
      Type.Object({
        outcome: Type.Union(
          DELIVERY_OUTCOMES.map((v) => Type.Literal(v)),
          { description: '本轮产出判定（四值——机器判定信号，如实申报）' },
        ),
        evidence: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 8000,
            description: '本轮证据摘录（可选——人读索引）',
          }),
        ),
      }),
    ]),
    execute: async (args) => {
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
        const payload: GoalEvidencePayload = {
          goalId: current.goalId,
          outcome: req.outcome,
          // wakeId 刀三接线（currentWakeId hook 缺席时如实缺席）
          ...(deps.currentWakeId !== undefined ? { wakeId: deps.currentWakeId() } : {}),
          ...(req.evidence !== undefined ? { evidence: req.evidence } : {}),
        };
        deps.sessions.appendEvent('goal/evidence', payload);
        return textResult(`轮结算已入账（${req.outcome}）——目标保持 active。\n${renderGoal(current)}`);
      }

      /* ---- 终态形：completed 机器否决（open 项）→ 结算 ---- */
      const req = args as { status: 'completed' | 'blocked'; evidence?: string; note?: string };
      if (req.status === 'completed') {
        // open 项否决（T2-A「完成由 todo 前沿涌现」执法位）：hook 未接（刀二前）
        // = 计划态面缺席，降级跳过——批内刀序诚实过渡，接线后即机器执法
        const openItems = deps.countOpenItems?.(current.goalId);
        if (openItems !== undefined && openItems > 0) {
          throw new AppError(
            GOAL_TRANSITION_INVALID,
            `计划态存在 ${openItems} 个未完项（open = 一切非 completed 状态项，deferred 含内）——完成由 todo 前沿涌现：先收尾未完项或逐项申报理由`,
          );
        }
      }
      const evidence = req.status === 'completed' ? String(req.evidence) : String(req.note);
      deps.store.settleDeclared(current.goalId, req.status, evidence, now);
      const goal = deps.store.getByGoalId(current.goalId)!;
      return textResult(`终态已落档（${req.status}）。\n${renderGoal(goal)}`);
    },
  };

  return [goalGet, goalSet, goalUpdate];
}
