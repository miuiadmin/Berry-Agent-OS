import { describe, it, expect } from 'vitest';
import { parsePermissionJudge, parseRouteDecision, parseCheckpointResult } from './prompts.js';

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
