/**
 * PR 裁决标签闸回归锁（API 治理 §6.13.6 CI 加强——2026-09-03 第九十一批）。
 * 两层：纯核心 adjudicatePrApiGate 三态直锁 + CLI spawn 红/绿探针
 * （check-topology.test.mjs 同款收编纪律——闸静默退化先在测试面红）。
 *
 * 层锁：
 * 1. 纯核心：面文件零触碰恒绿 / 触碰 + 裁决标签绿 / 触碰无标签红（指引文案
 *    点名三标签形与触到的文件）；
 * 2. 标签形执法：裸 api-break（无冒号说明段）不算裁决标签——形必须是
 *    `api-break: <说明>` 前缀式；
 * 3. 漏再生执法（第二刀）：快照在 diff 而两生成物零 diff 红；至少一生成物
 *    在 diff 即绿（可赢形态——渲染面全覆盖使然）；
 * 4. CLI 探针：--files/--label 绿路 + 面触碰无标签红路（exit 1 + stderr 指引）；
 * 5. BASE_SHA diff 路：临时 git 仓两 commit 真跑 `git diff --name-only BASE...HEAD`
 *    ——三点形 merge-base 语义的实证锁（PR 面而非全量差）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adjudicatePrApiGate } from './check-api-pr-gate.mjs';

/** 仓库根（本文件在 tools/ 下） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 被测脚本（cwd=ROOT 相对路径） */
const SCRIPT = join('tools', 'check-api-pr-gate.mjs');

describe('adjudicatePrApiGate：面变更裁决三态（纯核心）', () => {
  it('面文件零触碰 → 恒绿（非面 PR 零打扰）', () => {
    const verdict = adjudicatePrApiGate({ changedFiles: ['src/app/main.ts', 'docs/使用指南.md'], labels: [] });
    expect(verdict).toEqual({ ok: true, faceTouched: false });
  });
  it('面文件触碰 + 裁决标签 → 绿（标签随附在结果里供 CI 日志呈现）', () => {
    const verdict = adjudicatePrApiGate({
      changedFiles: ['src/contracts/api-surface.json', 'COMPATIBILITY.md'],
      labels: ['dependencies', 'api-add: 新增 exec 面符号'],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.faceTouched).toBe(true);
    expect(verdict.touched).toEqual(['src/contracts/api-surface.json']);
    expect(verdict.verdictLabels).toEqual(['api-add: 新增 exec 面符号']);
  });
  it('面文件触碰（含 DEP 注册簿与公开桶根）而无裁决标签 → 红 + 指引点名', () => {
    const verdict = adjudicatePrApiGate({
      changedFiles: ['src/contracts/deprecations.ts', 'src/contracts/index.ts'],
      labels: ['enhancement'],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.touched).toEqual(['src/contracts/deprecations.ts', 'src/contracts/index.ts']);
    expect(verdict.guidance).toContain('api-add:');
    expect(verdict.guidance).toContain('api-deprecate:');
    expect(verdict.guidance).toContain('api-break:');
    expect(verdict.guidance).toContain('src/contracts/deprecations.ts');
  });
  it('裸标签（无冒号说明段）不算裁决标签——形必须是前缀式', () => {
    // 标签值自身携带裁决级别宣告（api-break: <说明>）——裸词无法对账判级
    const verdict = adjudicatePrApiGate({ changedFiles: ['src/contracts/api-surface.json'], labels: ['api-break'] });
    expect(verdict.ok).toBe(false);
  });
  it('快照在 diff 而两生成物零 diff → 红（漏再生——§6.13.6 第二刀）', () => {
    const verdict = adjudicatePrApiGate({
      changedFiles: ['src/contracts/api-surface.json', 'src/app/main.ts'],
      labels: ['api-add: 新符号'],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.guidance).toContain('漏再生');
    expect(verdict.guidance).toContain('npm run build');
  });
  it('快照在 diff 且至少一生成物在 diff → 绿（可赢形态——渲染面全覆盖）', () => {
    // 只改 API参考.md 不改 COMPATIBILITY.md 的面变更（如 formFactors 调整）也过
    const onlyRef = adjudicatePrApiGate({
      changedFiles: ['src/contracts/api-surface.json', 'docs/API参考.md'],
      labels: ['api-add: 形态扩面'],
    });
    expect(onlyRef.ok).toBe(true);
    const onlyCompat = adjudicatePrApiGate({
      changedFiles: ['src/contracts/api-surface.json', 'COMPATIBILITY.md'],
      labels: ['api-break: 移除'],
    });
    expect(onlyCompat.ok).toBe(true);
  });
});

describe('check-api-pr-gate CLI：红/绿探针（spawn 真脚本）', () => {
  it('--files 面 + 生成物 + --label 裁决 → exit 0 且 stdout 呈现宣告', () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--files', 'src/app/x.ts,src/contracts/api-surface.json,COMPATIBILITY.md', '--label', 'api-add: 测试'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('api-add: 测试');
  });
  it('--files 面无裁决标签 → exit 1 且 stderr 指引（闸可红证明——静默退化先在此红）', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--files', 'src/contracts/index.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[PR 闸]');
    expect(r.stderr).toContain('api-break:');
  });
  it('两源缺席 → 用法错 exit 2（输入面不静默猜）', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('用法');
  });
});

describe('check-api-pr-gate CLI：BASE_SHA diff 路（三点形 merge-base 语义实证）', () => {
  it('临时仓两 commit——base 后触面文件的 PR diff 命中，base 前的触碰不计', () => {
    const dir = mkdtempSync(join(tmpdir(), 'berry-pr-gate-'));
    const git = (args, opts = {}) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', ...opts });
    try {
      // 基座 commit：面文件先在场（base 前的触碰不属本 PR 的 diff 面）
      mkdirSync(join(dir, 'src/contracts'), { recursive: true });
      writeFileSync(join(dir, 'src/contracts/api-surface.json'), '{"v":1}\n');
      writeFileSync(join(dir, 'README.md'), '# x\n');
      git(['init', '-q']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      git(['add', '.']);
      git(['commit', '-q', '-m', 'base']);
      const base = git(['rev-parse', 'HEAD']).stdout.trim();
      // PR commit：再触面文件 + 生成物伴生改（第二刀可赢条件）+ 顺手他文件
      writeFileSync(join(dir, 'src/contracts/api-surface.json'), '{"v":2}\n');
      writeFileSync(join(dir, 'COMPATIBILITY.md'), '# compat v2\n');
      writeFileSync(join(dir, 'README.md'), '# y\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'face change']);

      const red = spawnSync(process.execPath, [join(ROOT, SCRIPT), '--base', base], { cwd: dir, encoding: 'utf8' });
      expect(red.status).toBe(1); // 面触碰无标签 → 红（第一刀）
      expect(red.stderr).toContain('api-surface.json');

      const green = spawnSync(process.execPath, [join(ROOT, SCRIPT), '--base', base, '--label', 'api-add: v2'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(green.status).toBe(0); // 宣告即绿
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
