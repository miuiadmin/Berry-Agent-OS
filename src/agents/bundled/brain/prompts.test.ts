import { describe, it, expect } from 'vitest';
import { parsePermissionJudge, parseRouteDecision } from './prompts.js';

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
