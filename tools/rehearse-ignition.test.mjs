/**
 * 点火演练机器回归锁（API 治理进化批刀 O——§6.13.4 ④ 演练预演）。
 *
 * 锁的失效形态：演练机器自身腐化（翻转判据漂移 / 红清单解析失效 / 演练链
 * 中断）→ 点火日跑演练才发现机器是坏的（预演机器比动作本身先坏 = 最讽刺的
 * 单点故障）。两腿锁：
 *
 * 1. 纯核心单锁：flipIgnitionConstant 恰一处断言（零处/散拷即炸）+ 红清单
 *    解析（查号/失败题名两形态）——机器的判据面；
 * 2. --core 集成锁：spawn 真跑演练核心五连锁腿（隔离树 → 翻常量 → 负证腿
 *    → 正证腿 → PR 闸两跑）断言 exit 0 + 关键标记行在场——机器的链路面。
 *    重腿（typecheck + 面相关测试）点火日形态才有，回归锁不跑（省时不减锁面：
 *    重腿是子进程机械转发，腐化面在核心腿已全覆盖）。
 *
 * 运行注意：集成锁 spawn 内部自建临时 git worktree（detached @HEAD + 随跑随
 * 拆），主工作区零接触——与兄弟 session 并发面无扰。
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { flipIgnitionConstant, parseCheckReds, parseFailedTitles } from './rehearse-ignition.mjs';

/** 仓库根（本文件在 tools/ 下） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('点火演练机器纯核心（API 治理进化批刀 O）', () => {
  it('flipIgnitionConstant：恰一处翻——单站点形', () => {
    const src = 'export const API_ENFORCEMENT_IGNITED = false;\n';
    expect(flipIgnitionConstant(src)).toContain('API_ENFORCEMENT_IGNITED = true;');
  });

  it('flipIgnitionConstant：零处（已点火/改名）即炸——不留「翻了个寂寞」静默通道', () => {
    expect(() => flipIgnitionConstant('export const API_ENFORCEMENT_IGNITED = true;\n')).toThrow(/形状漂移.*0 次/);
    expect(() => flipIgnitionConstant('export const OTHER = false;\n')).toThrow(/形状漂移.*0 次/);
  });

  it('flipIgnitionConstant：两处（散拷进场）即炸——不留「翻半棵树」静默通道', () => {
    const twice =
      'a false; export const API_ENFORCEMENT_IGNITED = false;\nb export const API_ENFORCEMENT_IGNITED = false;\n';
    expect(() => flipIgnitionConstant(twice)).toThrow(/形状漂移.*2 次/);
  });

  it('parseCheckReds：查号去重排序（含字母亚形态 3c）——负证腿枚举对照面', () => {
    expect(parseCheckReds('x [查 1] a\n[查 3c] b\n[查 1] c')).toEqual(['1', '3c']);
    expect(parseCheckReds('无红输出')).toEqual([]);
  });

  it('parseFailedTitles：剥尾部耗时收失败题名——面相关测试腿同笔清单对照面', () => {
    expect(parseFailedTitles('  × 出口 4：某腿（注记） 2ms\n  × 常量现役 = false 0ms\n')).toEqual([
      '出口 4：某腿（注记）',
      '常量现役 = false',
    ]);
    expect(parseFailedTitles('  ✓ 全绿 3ms')).toEqual([]);
  });
});

describe('点火演练机器 --core 集成锁（隔离树真跑五连锁腿）', () => {
  it('核心链 exit 0 + 五连锁面标记行在场（演练机器腐化在此先红——预演机器不得比动作先坏）', () => {
    const r = spawnSync(process.execPath, [join('tools', 'rehearse-ignition.mjs'), '--core'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 240_000,
    });
    expect(r.status).toBe(0);
    const out = r.stdout;
    // 逐腿标记行：前置/隔离树/翻常量/负证腿/连锁面一/二/正证腿全绿/PR 闸负正/收尾对账
    expect(out).toContain('[演练 2] 单点翻常量');
    expect(out).toContain('红清单 = [查 1]');
    expect(out).toContain("快照纪元章 'ignited'");
    expect(out).toContain('COMPATIBILITY 执法纪元行 ignited');
    expect(out).toContain('check-api 全查 → exit 0 全绿');
    expect(out).toContain('点名裁决标签义务');
    expect(out).toContain('api-break: 标签 → exit 0');
    expect(out).toContain('零意外红，演练通过');
    expect(out).toContain('--core'); // 重腿跳过标记（本锁形态自证）
  }, 240_000);
});
