/**
 * L5 app — Web 通道刀二构建管线冒烟（契约篇 §6.8 构建管线条验收）。
 *
 * 真跑 vite build（同一份 vite.config.ts，CLI --outDir 覆写到临时目录——
 * 不落仓内 dist/webui，避免与并行的静态分发测试互扰）；断言产物形状：
 * index.html 在场 + 挂载点 + 打包资产引用。构建可慢（tailwind/react 冷启），
 * 超时帽 120s。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

/** 仓库根（vitest cwd = 仓根；显式取调本文件的上级三级——__dirname 不可用〔ESM〕） */
const ROOT = join(realpathSync(import.meta.dirname), '..', '..');

/** vite bin（devDep 直跑——不依赖全局安装） */
const VITE_BIN = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/** 临时产物目录（afterAll 清扫） */
const outDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'webui-build-smoke-')));
afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

const run = promisify(execFile);

describe('Web 通道刀二构建管线冒烟（vite build 产物形状）', () => {
  it('vite build：index.html 在场 + #root 挂载点 + assets 引用', async () => {
    const { stdout, stderr } = await run(
      process.execPath,
      [VITE_BIN, 'build', '-c', 'src/webui/client/vite.config.ts', '--outDir', outDir, '--emptyOutDir'],
      { cwd: ROOT, timeout: 110_000 },
    );
    void stdout;
    void stderr; // 构建日志不作断言面（产物形状是唯一裁决）

    // ① index.html 在场且含挂载点与入口脚本
    const index = join(outDir, 'index.html');
    expect(existsSync(index)).toBe(true);
    const html = readFileSync(index, 'utf8');
    expect(html).toContain('id="root"');
    expect(html).toMatch(/<script[^>]*type="module"/);

    // ② 打包资产目录在场（JS bundle 至少一件）
    const assets = join(outDir, 'assets');
    expect(existsSync(assets)).toBe(true);
    const bundled = readdirSync(assets).filter((f) => f.endsWith('.js'));
    expect(bundled.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
