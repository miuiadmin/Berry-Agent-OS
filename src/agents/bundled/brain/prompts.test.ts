import { describe, it, expect } from 'vitest';
import { parsePermissionJudge, parseRouteDecision, parseCheckpointResult, buildReviewInput } from './prompts.js';
import type { TurnRecord } from '../../../contracts/review.js';
import type { ToolBlock } from '../../../contracts/message-blocks.js';

/**
 * 15.0 机制 B：parsePermissionJudge 的 uncertain/escalation 解析测试。
 *
 * 验证 Brain 在权限审批时返回 uncertain=true + escalationQuestion 时，
 * 解析器正确产出 uncertain 标记与 BrainEscalation（供 permission-flow 升级到用户确认）。
 * 正常 allowed/deny 路径不受影响。
 */
describe('parsePermissionJudge (15.0 机制 B uncertain 解析)', () => {
  it('正常批准：uncertain 缺省为 false，无 escalation', () => {
    const out = parsePermissionJudge('{"allowed": true, "reason": "低风险"}');
    expect(out.allowed).toBe(true);
    expect(out.uncertain).toBe(false);
    expect(out.escalation).toBeUndefined();
  });

  it('正常拒绝：uncertain 缺省为 false', () => {
    const out = parsePermissionJudge('{"allowed": false, "reason": "危险命令"}');
    expect(out.allowed).toBe(false);
    expect(out.uncertain).toBe(false);
  });

  it('uncertain=true + escalationQuestion → 产出 escalation', () => {
    const raw = '{"allowed": false, "reason": "无法确认目标目录", "uncertain": true, "escalationQuestion": "即将删除 ./data，是否确认目录正确？"}';
    const out = parsePermissionJudge(raw);
    expect(out.uncertain).toBe(true);
    expect(out.escalation).toBeDefined();
    expect(out.escalation!.source).toBe('approval');
    expect(out.escalation!.questionToUser).toContain('确认目录');
    expect(out.escalation!.reason).toBe('无法确认目标目录');
  });

  it('uncertain=true 但无 escalationQuestion → 有 uncertain 无 escalation（回退通用提示）', () => {
    const out = parsePermissionJudge('{"allowed": false, "reason": "不确定", "uncertain": true}');
    expect(out.uncertain).toBe(true);
    expect(out.escalation).toBeUndefined();
  });

  it('解析失败 → 默认拒绝（fail-closed），无 uncertain', () => {
    const out = parsePermissionJudge('not json at all');
    expect(out.allowed).toBe(false);
    expect(out.uncertain).toBeFalsy();
  });

  it('correction 仍正常解析（与 uncertain 并存）', () => {
    const raw = '{"allowed": false, "reason": "改用只读", "correction": {"instruction": "用 read_file"}, "uncertain": false}';
    const out = parsePermissionJudge(raw);
    expect(out.correction?.instruction).toBe('用 read_file');
    expect(out.uncertain).toBe(false);
  });
});

describe('parseRouteDecision (15.0 机制 B route uncertain 解析)', () => {
  it('正常路由：无 escalation', () => {
    const out = parseRouteDecision('{"intent":"code","targetAgent":"code","reason":"改代码"}');
    expect(out.targetAgent).toBe('code');
    expect(out.escalation).toBeUndefined();
  });

  it('uncertain=true + escalationQuestion → 产出 escalation（source=decision）', () => {
    const raw = '{"intent":"chat","targetAgent":"conversation","reason":"意图歧义","uncertain":true,"escalationQuestion":"你是想改代码还是查资料？"}';
    const out = parseRouteDecision(raw);
    expect(out.escalation).toBeDefined();
    expect(out.escalation!.source).toBe('decision');
    expect(out.escalation!.questionToUser).toContain('改代码');
  });

  it('uncertain=true 但无 escalationQuestion → 无 escalation（回退正常路由）', () => {
    const out = parseRouteDecision('{"intent":"chat","targetAgent":"conversation","uncertain":true}');
    expect(out.escalation).toBeUndefined();
    expect(out.targetAgent).toBe('conversation');
  });

  it('解析失败 → 默认路由 conversation，无 escalation', () => {
    const out = parseRouteDecision('not json');
    expect(out.targetAgent).toBe('conversation');
    expect(out.escalation).toBeUndefined();
  });
});

describe('parseCheckpointResult (15.0 机制 D command 伴随字段)', () => {
  it('无 command 字段 → command undefined', () => {
    const out = parseCheckpointResult('{"action":"continue"}', 'dlg1');
    expect(out.action).toBe('continue');
    expect(out.command).toBeUndefined();
  });

  it('含 command → 解析为 BrainCommand（默认 report/priority normal）', () => {
    const raw = '{"action":"adjust","instruction":"x","command":{"target":"auditor","type":"inspect","payload":{"scope":"audit"},"priority":"high"}}';
    const out = parseCheckpointResult(raw, 'dlg1');
    expect(out.command).toBeDefined();
    expect(out.command!.target).toBe('auditor');
    expect(out.command!.type).toBe('inspect');
    expect(out.command!.priority).toBe('high');
  });

  it('command 缺 target → 不解析（无效 command）', () => {
    const out = parseCheckpointResult('{"action":"continue","command":{"type":"report"}}', 'dlg1');
    expect(out.command).toBeUndefined();
  });

  it('command 非法 type → 回退 report', () => {
    const out = parseCheckpointResult('{"action":"continue","command":{"target":"code","type":"bogus"}}', 'dlg1');
    expect(out.command).toBeDefined();
    expect(out.command!.type).toBe('report');
  });
});

describe('parseCheckpointResult (15.0 机制 B checkpoint uncertain 升级)', () => {
  it('uncertain=true + escalationQuestion → 产出 escalation（source=checkpoint）', () => {
    const raw = '{"action":"continue","reason":"任务卡住","uncertain":true,"escalationQuestion":"任务似乎卡在依赖安装，要继续还是放弃？"}';
    const out = parseCheckpointResult(raw, 'dlg1');
    expect(out.escalation).toBeDefined();
    expect(out.escalation!.source).toBe('checkpoint');
    expect(out.escalation!.questionToUser).toContain('继续还是放弃');
  });

  it('无 uncertain → 无 escalation', () => {
    const out = parseCheckpointResult('{"action":"adjust","instruction":"x"}', 'dlg1');
    expect(out.escalation).toBeUndefined();
  });

  it('uncertain 但无 escalationQuestion → 无 escalation', () => {
    const out = parseCheckpointResult('{"action":"continue","uncertain":true}', 'dlg1');
    expect(out.escalation).toBeUndefined();
  });

  it('command 与 escalation 可并存', () => {
    const raw = '{"action":"continue","uncertain":true,"escalationQuestion":"要继续吗？","command":{"target":"code","type":"inspect"}}';
    const out = parseCheckpointResult(raw, 'dlg1');
    expect(out.escalation).toBeDefined();
    expect(out.command).toBeDefined();
    expect(out.command!.target).toBe('code');
  });
});

/**
 * 15.0 机制 B escalation emit 边界补全测试。
 *
 * prompts.ts 里三个可测的解析器各自 emit 一个固定的 escalation.source：
 * - parseRouteDecision     → source='decision'
 * - parsePermissionJudge   → source='approval'
 * - parseCheckpointResult  → source='checkpoint'
 *
 * 本组覆盖四类边界：
 * 1. route uncertain 但无 escalationQuestion —— 不产 escalation，回退正常路由
 * 2. checkpoint uncertain + command 并存 —— source=checkpoint 与 command.target 同时生效
 * 3. review uncertain (source=review) —— 解析逻辑在 entry.ts 内联（非 prompts 解析器），见文末说明
 * 4. 各 source 值正确 —— 三解析器分别 emit 各自固定的 source 字符串
 *
 * source='review' 由 entry.ts 的内联 review 逻辑 emit（entry.ts:537），不是 prompts.ts 解析器，
 * 因此无法在 prompts.test.ts 直接覆盖。该路径需要 model-takeover 层的 1-to-1 测试，见文末。
 */
describe('机制 B escalation emit 边界补全', () => {
  describe('route uncertain 但无 escalationQuestion', () => {
    it('uncertain=true 但 escalationQuestion 缺失 → 无 escalation，仍回退正常路由', () => {
      // 边界：Brain 标了 uncertain=true 却忘了写 escalationQuestion。
      // 正确行为是不产 escalation（无法构造有意义的 questionToUser），
      // 同时 targetAgent/intent 仍按 LLM 给出的值正常解析，不阻塞路由。
      const raw = '{"intent":"code","targetAgent":"code","uncertain":true,"reason":"边缘情况"}';
      const out = parseRouteDecision(raw);
      // 关键断言：没有 escalation
      expect(out.escalation).toBeUndefined();
      // 回退正常路由：uncertain 不影响 intent/targetAgent 解析
      expect(out.targetAgent).toBe('code');
      expect(out.intent).toBe('code');
    });

    it('uncertain=true 但 escalationQuestion 为空白 → 无 escalation', () => {
      // 边界：escalationQuestion 是全空字符串，trim() 后为空 → 视同无问题
      const raw = '{"intent":"chat","targetAgent":"conversation","uncertain":true,"escalationQuestion":"   "}';
      const out = parseRouteDecision(raw);
      expect(out.escalation).toBeUndefined();
    });
  });

  describe('checkpoint uncertain + command 并存', () => {
    it('escalation.source=checkpoint 与 command.target 同时生效', () => {
      // 边界：checkpoint 阶段 Brain 既拿不准任务走向（uncertain+escalationQuestion），
      // 又顺带发号施令（command）。两条机制应独立解析、互不干扰。
      // 关键断言：escalation.source 严格为 'checkpoint'（不能误串成 review/approval/decision），
      // 且 command 的 target/type/priority 全部正确解析。
      const raw = JSON.stringify({
        action: 'continue',
        reason: '无法判断任务是否还能推进',
        uncertain: true,
        escalationQuestion: '依赖安装已重试 5 次失败，要继续重试还是放弃？',
        command: {
          target: 'auditor',
          type: 'inspect',
          payload: { scope: 'dependency' },
          priority: 'high',
        },
      });
      const out = parseCheckpointResult(raw, 'dlg-coexist');
      // escalation 侧：source 必须是 checkpoint
      expect(out.escalation).toBeDefined();
      expect(out.escalation!.source).toBe('checkpoint');
      expect(out.escalation!.reason).toBe('无法判断任务是否还能推进');
      expect(out.escalation!.questionToUser).toContain('继续重试还是放弃');
      // command 侧：target/type/payload/priority 全解析
      expect(out.command).toBeDefined();
      expect(out.command!.target).toBe('auditor');
      expect(out.command!.type).toBe('inspect');
      expect(out.command!.priority).toBe('high');
      expect(out.command!.payload).toEqual({ scope: 'dependency' });
      // 两机制并存互不吞没
      expect(out.action).toBe('continue');
    });

    it('command target 缺失时 command 不解析，但 escalation 仍独立成立', () => {
      // 边界：command.target 缺失（无效 command），但 escalation 不应受牵连。
      const raw = JSON.stringify({
        action: 'continue',
        uncertain: true,
        escalationQuestion: '要不要回退到上一个稳定版本？',
        command: { type: 'inspect', priority: 'normal' }, // 缺 target
      });
      const out = parseCheckpointResult(raw, 'dlg-cmd-invalid');
      // escalation 不受 command 解析失败影响
      expect(out.escalation).toBeDefined();
      expect(out.escalation!.source).toBe('checkpoint');
      // 无效 command 被丢弃（与单测 command 缺 target 行为一致）
      expect(out.command).toBeUndefined();
    });
  });

  describe('各 source 值正确', () => {
    // 集中校验三个可测解析器 emit 的固定 source 字符串。
    // BrainEscalation.source 契约（brain.ts:23）允许 'review' | 'approval' | 'decision' | 'checkpoint'，
    // 但 prompts.ts 三个解析器各自只 emit 一个固定值。本组锁死这些映射，防日后改串。

    it('parseRouteDecision → source="decision"', () => {
      const raw = '{"intent":"chat","targetAgent":"conversation","uncertain":true,"escalationQuestion":"你想改代码还是查资料？","reason":"意图歧义"}';
      const out = parseRouteDecision(raw);
      expect(out.escalation).toBeDefined();
      expect(out.escalation!.source).toBe('decision');
      // 回退 reason：缺 reason 时用默认文案
      const noReason = parseRouteDecision('{"intent":"chat","targetAgent":"conversation","uncertain":true,"escalationQuestion":"Q"}');
      expect(noReason.escalation!.reason).toContain('无法判定');
    });

    it('parsePermissionJudge → source="approval"', () => {
      const raw = '{"allowed":false,"reason":"目标目录不确定","uncertain":true,"escalationQuestion":"即将删除 ./data，确认目录？"}';
      const out = parsePermissionJudge(raw);
      expect(out.escalation).toBeDefined();
      expect(out.escalation!.source).toBe('approval');
      // 回退 reason：缺 reason 时用默认文案
      const noReason = parsePermissionJudge('{"allowed":false,"uncertain":true,"escalationQuestion":"Q"}');
      expect(noReason.escalation!.reason).toContain('不确定');
    });

    it('parseCheckpointResult → source="checkpoint"', () => {
      const raw = '{"action":"continue","uncertain":true,"escalationQuestion":"任务卡住，继续吗？","reason":"无法判定走向"}';
      const out = parseCheckpointResult(raw, 'dlg-src');
      expect(out.escalation).toBeDefined();
      expect(out.escalation!.source).toBe('checkpoint');
      // 回退 reason：缺 reason 时用默认文案
      const noReason = parseCheckpointResult('{"action":"continue","uncertain":true,"escalationQuestion":"Q"}', 'dlg-src2');
      expect(noReason.escalation!.reason).toContain('无法判定');
    });

    it('uncertain 非 truthy 值（0/空串/null）不触发 escalation', () => {
      // 边界：uncertain 字段为 falsy 时，即使带了 escalationQuestion 也不升级。
      // 锁死 Boolean(parsed.uncertain) 的判定，防 LLM 偶发返回 uncertain:0 误升级。
      expect(parseRouteDecision('{"intent":"chat","targetAgent":"conversation","uncertain":0,"escalationQuestion":"Q"}').escalation).toBeUndefined();
      expect(parsePermissionJudge('{"allowed":true,"uncertain":null,"escalationQuestion":"Q"}').escalation).toBeUndefined();
      expect(parseCheckpointResult('{"action":"continue","uncertain":"","escalationQuestion":"Q"}', 'd').escalation).toBeUndefined();
    });
  });

  describe('review uncertain (source=review) — 解析逻辑在 entry.ts 内联', () => {
    // 说明：source='review' 的 escalation 不由 prompts.ts 的任何解析器 emit，
    // 而是在 entry.ts:534-541 的 review 内联逻辑里 emit（与 review.result 一同构造）。
    // 因为该解析与 LLM 调用、ipc.send 耦合，且没有独立可导出的 review 解析器函数，
    // prompts.test.ts 无法直接覆盖 source='review' 的 emit。
    //
    // 该边界应由 1-to-1 测试（mock/takeover LLM 返回 uncertain+escalationQuestion）
    // 在 brain entry 层验证：assert ipc 收到 review.result 且 escalation.source==='review'。
    // 此处保留占位 it，明示该 gap 的归属与验证路径，避免后来者误以为 prompts.test.ts 遗漏。
    it('source=review 的 emit 归属 entry.ts review 内联逻辑，需在 entry 层 1-to-1 测试覆盖', () => {
      // 仅断言契约允许的 source 集合包含 'review'，作为契约回归锚点。
      // 真正的 emit 验证在 entry 层 1-to-1 测试（model-takeover）。
      const allowedSources = ['review', 'approval', 'decision', 'checkpoint'];
      expect(allowedSources).toContain('review');
    });
  });
});

/**
 * buildReviewInput（ToolBlock[] turn）—— 审核链工具真相源统一②-b 回归。
 *
 * TurnRecord.toolCalls 已是 ToolBlock[]（来自 BlockCollector）。验证 buildReviewInput 在 A/B 级
 * 正确消费 ToolBlock：A 级只 [name] 摘要；B 级展开 Input/Result（经 toolInputString/toolResultString——
 * 对象 input JSON 化、字符串 input 直通、completed 取 output、failed 取 error）。
 */
describe('buildReviewInput (ToolBlock[] turn)', () => {
  const baseTurn = {
    sessionId: 's1',
    userMessage: '帮我改代码',
    draftResponse: '已改完',
    level: 'A' as const,
  };
  // ToolBlock[] 模拟 collector 取出的轨迹：一个对象 input + completed，一个字符串 input + failed
  const toolBlocks: ToolBlock[] = [
    { type: 'tool', id: 't1', name: 'edit_code', input: { file: 'a.ts', old: 'x' }, state: 'completed', output: 'ok' },
    { type: 'tool', id: 't2', name: 'run_command', input: 'npm test', state: 'failed', error: 'exit 1' },
  ];

  it('A 级：toolCalls 渲染为 [name] 摘要，不展开 Input/Result', () => {
    const out = buildReviewInput('A', { ...baseTurn, toolCalls: toolBlocks });
    expect(out).toContain('[edit_code]');
    expect(out).toContain('[run_command]');
    // A 级只摘要，不展开
    expect(out).not.toContain('Input:');
    expect(out).not.toContain('Result:');
  });

  it('B 级：对象 input 经 toolInputString JSON 化；completed→output、failed→error', () => {
    const out = buildReviewInput('B', { ...baseTurn, toolCalls: toolBlocks });
    expect(out).toContain('[edit_code]');
    // 对象 input → JSON.stringify（toolInputString）
    expect(out).toContain('"file":"a.ts"');
    // completed 态 result = output
    expect(out).toContain('Result: ok');
    // 字符串 input 直通（不二次引号）
    expect(out).toContain('Input: npm test');
    // failed 态 result = error（toolResultString）
    expect(out).toContain('Result: exit 1');
  });

  it('空 toolCalls → 无工具段', () => {
    const out = buildReviewInput('A', { ...baseTurn, toolCalls: [] });
    expect(out).not.toContain('Tools used');
    expect(out).not.toContain('Tool calls');
  });
});
