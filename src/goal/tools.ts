/**
 * L3 goal — 工具三件（骨架篇 §6.8：模型面——目标内容在模型）。
 *
 * goal_get（状态投影）/ goal_set（设定目标+预算）/ goal_update（申报终态——
 * completed 必附证据是 schema 执法位：union 分支逐字面绑定必填字段，参数
 * 校验段即拦截，不靠提示词自觉）。转移合法性经 machine 判定，非法即响亮
 * 拒绝（GOAL_* 码）——宁拒绝不静默。
 */

import { Type } from '../contracts/typebox.js';
import { AppError, GOAL_ACTIVE_EXISTS, GOAL_TRANSITION_INVALID, GOAL_NOT_FOUND } from '../contracts/errors.js';
import type { ToolDefinition, AgentToolResult } from '../contracts/tools.js';
import { canSetGoal, canUpdateGoal } from './machine.js';
import type { GoalRecord } from './machine.js';
import { renderDisciplineClauses } from './prompts.js';
import type { GoalStore } from './store.js';

/** 工具构造依赖（goal 应用 apply 期装配） */
export interface GoalToolsDeps {
  /** goals 表 DAO */
  readonly store: GoalStore;
  /** 当前会话 id 活取值（/new 热切换后自动跟新会话走） */
  readonly getSessionId: () => string | undefined;
}

/** goal 行 → 人读投影文本（工具结果用——全字段如实示态，预算尽≠完成） */
function renderGoal(goal: GoalRecord): string {
  const lines = [
    `目标：${goal.objective}`,
    `状态：${goal.status}${goal.stopReason !== null ? `（原因：${goal.stopReason}）` : ''}`,
    `预算：已用 ${goal.tokensUsed} / ${goal.tokenBudget} tokens`,
    // 开洞申请如实示态（第二十四批题3a）：用户 /goal 面可见模型申报的写面需求
    `续跑工具面：${goal.needsWrite ? '已申报写面开洞（needsWrite——续跑轮全量工具）' : '只读收紧（read 类 + goal_get/goal_update）'}`,
  ];
  if (goal.evidence !== null) lines.push(`证据/原因：${goal.evidence}`);
  lines.push(`创建：${new Date(goal.createdAt).toISOString()}；更新：${new Date(goal.updatedAt).toISOString()}`);
  return lines.join('\n');
}

/** 纯文本工具结果壳（与 memory 工具同款极简形态） */
function textResult(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** 构造工具三件（goal 应用注册进 ctx.tools——tools_change 原位刷新即模型可见） */
export function createGoalTools(deps: GoalToolsDeps): readonly ToolDefinition[] {
  /* ---------------- goal_get：当前 goal 全字段投影 ---------------- */
  const goalGet: ToolDefinition = {
    name: 'goal_get',
    label: '查看目标',
    effect: 'read',
    description:
      '查看当前会话的长目标（goal）状态：目标内容、状态机档位（active/needs-resume/completed/blocked/stopped）、预算用量、申报证据。无目标时如实报告无目标。',
    parameters: Type.Object({}),
    execute: async () => {
      const sessionId = deps.getSessionId();
      const goal = sessionId === undefined ? undefined : deps.store.get(sessionId);
      if (goal === undefined) return textResult('当前会话没有设定目标（goal_set 可设定）。');
      return textResult(renderGoal(goal));
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
      const current = deps.store.get(sessionId);
      // active 行占位即拒（一径：先 goal_update 申报终态或 /goal stop，再重设）
      if (!canSetGoal(current)) {
        throw new AppError(
          GOAL_ACTIVE_EXISTS,
          '当前会话已有进行中的目标（active）——先完成/停止当前目标（goal_update 或 /goal stop）再设定新目标',
        );
      }
      const now = Date.now();
      deps.store.setActive(sessionId, objective, tokenBudget, needsWrite, now);
      const goal = deps.store.get(sessionId)!;
      const replaced = current !== undefined ? `（已覆盖旧目标的 ${current.status} 行）` : '';
      return textResult(`目标已设定并激活${replaced}。\n${renderGoal(goal)}`);
    },
  };

  /* ---------------- goal_update：申报终态（completed 必附证据——schema 执法位） ---------------- */
  const goalUpdate: ToolDefinition = {
    name: 'goal_update',
    label: '申报目标终态',
    effect: 'write',
    description: [
      '申报当前目标的终态。completed = 目标已达成——必须附分级证据（可复现验证 > 工具输出摘录 > 口头断言），任何需求只有口头断言 = 未完成不许申报；blocked = 连续 3 个 goal 轮次卡同一阻塞——附原因与已尝试的办法。',
      '申报后目标定格为终态（可用 goal_set 重设新目标）。',
    ].join('\n'),
    // union 分支绑定必填字段：completed 无 evidence / blocked 无 note 过不了参数校验段
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
    ]),
    execute: async (args) => {
      const sessionId = deps.getSessionId();
      if (sessionId === undefined) return textResult('无会话上下文——goal 不可用。', true);
      const req = args as { status: 'completed' | 'blocked'; evidence?: string; note?: string };
      const current = deps.store.get(sessionId);
      if (current === undefined) {
        throw new AppError(GOAL_NOT_FOUND, '当前会话没有设定目标（goal_set 先设定）');
      }
      if (!canUpdateGoal(current)) {
        throw new AppError(
          GOAL_TRANSITION_INVALID,
          `目标当前为 ${current.status}——只有 active 态可申报终态（needs-resume 态先 /goal resume 重新授权）`,
        );
      }
      const now = Date.now();
      const evidence = req.status === 'completed' ? String(req.evidence) : String(req.note);
      deps.store.settleDeclared(sessionId, req.status, evidence, now);
      const goal = deps.store.get(sessionId)!;
      return textResult(`终态已落档（${req.status}）。\n${renderGoal(goal)}`);
    },
  };

  return [goalGet, goalSet, goalUpdate];
}
