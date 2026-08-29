/**
 * safety — PM 白名单旗推导器单测（契约篇 §1.7 external 载体，external carrier 落码批）。
 *
 * 纯旗形断言（三坑回归锁：归一/每根一旗/预建）+ 一发真跑（spawn 真 PM 子进程
 * 验证旗面语义：写根内过、写根外 ERR_ACCESS_DENIED——derivePmFlags 的产物
 * 不是字符串而是真执法面，旗形对了语义错了一样是漏。真跑形态对齐 PoC ⑧，
 * 但旗面出自生产推导器本身，非测试内复刻）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { derivePmFlags } from './pm-flags.js';

/** 实跑收齐 stdout/stderr/退出码的辅助（PM 真跑用） */
function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (err += c));
    proc.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

describe('derivePmFlags — 旗形三坑回归锁（纯逻辑）', () => {
  it('领衔序：--permission 打头 + 全域读一旗 + 每写根一旗（坑二：v24 逗号拼接已废弃）', () => {
    const flags = derivePmFlags(['/a/root', '/b/root']);
    // 总开关领衔（allow-fs-* 是其子旗，缺总开关直接 ERR_MISSING_OPTION）
    expect(flags[0]).toBe('--permission');
    expect(flags[1]).toBe('--allow-fs-read=*');
    // 两根 = 两旗（逗号拼接整串被当单一路径字面量——多根必须每根重复一旗）
    expect(flags.filter((f) => f.startsWith('--allow-fs-write=')).length).toBe(2);
  });

  it('坑一归一：darwin /var symlink 路径推导为 /private/var 同形（与运行时路径匹配）', () => {
    // darwin 的 tmpdir() 返回 /var/folders/... 形（symlink），realpath 是
    // /private/var/...——PM 按归一化绝对路径匹配白名单，两形不同即根内全拒
    const raw = mkdtempSync(join(tmpdir(), 'pm-flags-norm-')); // 不存在的尾段也不怕：坑三预建先行
    const flags = derivePmFlags([raw]);
    const writeFlag = flags.find((f) => f.startsWith('--allow-fs-write='))!;
    expect(writeFlag).toBe(`--allow-fs-write=${realpathSync(raw)}`);
    rmSync(raw, { recursive: true, force: true });
  });

  it('坑三预建：写根目录不存在时推导即建（白名单不静默失效）', () => {
    const stage = mkdtempSync(join(realpathSync(tmpdir()), 'pm-flags-prebuild-'));
    const absent = join(stage, 'not-yet', 'deep'); // 三层不存在的深路径
    derivePmFlags([absent]);
    // 推导返回后目录已在（否则 realpath 归一断链 → 根内写被 ERR_ACCESS_DENIED）
    expect(existsSync(absent)).toBe(true);
    expect(statSync(absent).isDirectory()).toBe(true);
    rmSync(stage, { recursive: true, force: true });
  });

  it('TS 源形态：补 --allow-worker（tsx→esbuild 转译走 worker 线程服务）；编译产物形态不补', () => {
    expect(derivePmFlags(['/a'], { tsTransform: true })).toContain('--allow-worker');
    expect(derivePmFlags(['/a'])).not.toContain('--allow-worker');
    expect(derivePmFlags(['/a'], { tsTransform: false })).not.toContain('--allow-worker');
  });
});

describe('derivePmFlags — PM 真执法单点（真 spawn 子进程）', () => {
  it('旗面语义：写根内过 / 写根外 ERR_ACCESS_DENIED（拒的签名必须对）', { timeout: 30_000 }, async () => {
    const stage = mkdtempSync(join(realpathSync(tmpdir()), 'pm-flags-live-'));
    const inside = join(stage, 'allowed');
    const outside = join(stage, 'outside');
    const flags = derivePmFlags([inside]); // 预建 + 归一都在推导内
    // 子探测脚本：根内写应过、根外写应拒——报 JSON 到 stdout
    const probe = `
      const { writeFileSync } = require('node:fs');
      const report = {};
      for (const [k, p] of [['inside', ${JSON.stringify(inside)}], ['outside', ${JSON.stringify(outside)}]]) {
        try { writeFileSync(p + '/probe.txt', 'x'); report[k] = { pass: true, code: null }; }
        catch (err) { report[k] = { pass: false, code: err.code ?? 'NO_CODE' }; }
      }
      console.log('RESULT:' + JSON.stringify(report));
    `;
    const r = await run([...flags, '-e', probe]);
    const line = r.out.split('\n').find((l) => l.startsWith('RESULT:'));
    expect(line, `探测无回报（stderr：${r.err.slice(0, 300)}）`).toBeDefined();
    const report = JSON.parse(line!.slice('RESULT:'.length)) as Record<string, { pass: boolean; code: string | null }>;
    // 根内过、根外拒且拒的签名是 PM 拦截码（ERR_ACCESS_DENIED）
    expect(report.inside).toEqual({ pass: true, code: null });
    expect(report.outside).toEqual({ pass: false, code: 'ERR_ACCESS_DENIED' });
    rmSync(stage, { recursive: true, force: true });
  });
});
