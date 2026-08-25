/**
 * L4 exec 单元测试 — spawn 管道（真子进程，无 mock）。
 *
 * 覆盖：失败二分两腿（未启动抛 EXEC_SPAWN_FAILED 携 cause.code / 退出非零
 * 正常返回）/ 超时树杀抛 TOOL_TIMEOUT / stdin 一次性喂入 / onOutput 流式 /
 * 合并预算保尾截断 / abort 取消正常结算 / classifyDenials 分类。
 * POSIX 环境跑（CI = darwin/linux）；Windows 无 bash 不在本测试矩阵。
 */

import { describe, expect, it } from 'vitest';
import { AppError, EXEC_SPAWN_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import { classifyDenials, runArgv, OUTPUT_BUDGET_BYTES } from './spawn.js';

/** 断言拒绝码（错误码是唯一判据） */
async function expectRejectCode(fn: () => Promise<unknown>, code: string): Promise<AppError> {
  try {
    await fn();
    expect.unreachable('应当抛错');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
}

describe('失败二分（未启动 ≠ 退出非零）', () => {
  it('程序不存在 = EXEC_SPAWN_FAILED 携 cause.code=ENOENT（绝不折算 exit 1）', async () => {
    const err = await expectRejectCode(() => runArgv(['definitely-not-a-program-xyz']), EXEC_SPAWN_FAILED);
    expect(err.message).toContain('ENOENT');
  });
  it('退出非零 = 正常返回 {exitCode, stderr}——不是异常', async () => {
    const run = await runArgv(['bash', '-c', 'echo boom >&2; exit 3']);
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain('boom');
    expect(run.signal).toBeUndefined();
  });
});

describe('正常执行', () => {
  it('stdout 采集 + exitCode 0 + durationMs 计时', async () => {
    const run = await runArgv(['bash', '-c', 'echo hello']);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('hello\n');
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.truncated).toBe(false);
  });
  it('stdin 一次性写入（cat 回显）', async () => {
    const run = await runArgv(['bash', '-c', 'cat'], { stdin: 'abc-stdin' });
    expect(run.stdout).toBe('abc-stdin');
  });
  it('子进程不读 stdin 也不算失败（EPIPE 吞掉）', async () => {
    const run = await runArgv(['bash', '-c', 'echo ok'], { stdin: 'ignored' });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('ok\n');
  });
});

describe('超时自治（execute 内自计时 + 树杀）', () => {
  it('到点抛 TOOL_TIMEOUT，不等满命令时长', async () => {
    const started = Date.now();
    await expectRejectCode(() => runArgv(['bash', '-c', 'sleep 30'], { timeoutMs: 300 }), TOOL_TIMEOUT);
    expect(Date.now() - started).toBeLessThan(5000); // 没陪跑 30s
  });
  it('树杀杀整组：孙进程一并终结（killpg 负 pid）', async () => {
    // bash -c 起 sleep 孙进程后主 sleep 挂着；超时树杀后全组死——若只杀直接
    // 子进程，孙 sleep 会拖着 close 不来（测试以 TOOL_TIMEOUT 及时到为证）
    await expectRejectCode(() => runArgv(['bash', '-c', 'sleep 30 & sleep 30'], { timeoutMs: 300 }), TOOL_TIMEOUT);
  });
});

describe('abort 取消（正常结算，signal 字段识别）', () => {
  it('abort 后树杀并以带 signal 的结果结算（不抛错）', async () => {
    const controller = new AbortController();
    const runPromise = runArgv(['bash', '-c', 'sleep 30'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const run = await runPromise;
    expect(run.exitCode).toBeNull();
    expect(run.signal).toBeDefined();
  });
});

describe('onOutput 流式增量', () => {
  it('执行中即推（run-to-completion 单品是 pi-7 反面）', async () => {
    const chunks: Array<{ stream: string; text: string }> = [];
    const run = await runArgv(['bash', '-c', 'echo one; echo two >&2; echo three'], {
      onOutput: (chunk) => chunks.push({ stream: chunk.stream, text: chunk.text }),
    });
    expect(run.stdout).toContain('one');
    expect(chunks.length).toBeGreaterThanOrEqual(2); // 不是终态一次性倒
    expect(chunks.some((c) => c.stream === 'stderr' && c.text.includes('two'))).toBe(true);
  });
});

describe('输出预算（合并 60 KiB 保尾截断）', () => {
  it('超预算保尾：尾部标记可见、头部长串被弃、truncated=true', async () => {
    // 头部 100 KiB 垃圾 + 尾部标记——保尾语义 = 标记必须在
    const run = await runArgv(['bash', '-c', 'head -c 102400 /dev/zero | tr "\\0" "a"; echo TAIL-MARKER']);
    expect(run.truncated).toBe(true);
    expect(run.stdout.endsWith('TAIL-MARKER\n')).toBe(true);
    expect(run.stdout.startsWith('aaaa')).toBe(true); // 保尾 = 尾留头弃
    const total = Buffer.byteLength(run.stdout, 'utf8') + Buffer.byteLength(run.stderr, 'utf8');
    expect(total).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES + 128); // 预算线内（标注行余量）
  });
});

describe('classifyDenials（stderr 按后端签名分类）', () => {
  it('大小写不敏感子串命中；未命中 = 空数组', () => {
    expect(classifyDenials('Operation not permitted', ['Operation not permitted'])).toEqual([
      'Operation not permitted',
    ]);
    expect(classifyDenials('operation NOT permitted', ['Operation not permitted'])).toEqual([
      'Operation not permitted',
    ]);
    expect(classifyDenials('just a warning', ['Operation not permitted'])).toEqual([]);
    expect(classifyDenials('anything', [])).toEqual([]);
  });
});
