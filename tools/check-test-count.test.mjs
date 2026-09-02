/**
 * check-test-count 机器闸回归锁（全面复盘 20260902 G-3④）：真脚本 × 夹具四语
 * README + 伪 npm test 日志——绿路 + 三红路（下限失真 / 四语不一致 / 宣称面
 * 漂移）逐一点名。锚失效形态：脚本被静默删、汇总行正则面退化、四语宣称写法
 * 改形——绿路 exit≠0 或红路 exit=0，先在测试面红（闸的闸，check-events.test
 * 同款先例）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/** 仓库根（本文件在 tools/ 下） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 夹具根清单（afterAll 统一清） */
const roots = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 造夹具根：四语 README（overrides 点名改写单语）+ 伪 npm test 日志文件路径。
 *  行形态仿真四语千分位：zh/en 逗号 / es 点 / fr 空格。 */
function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'berry-check-test-count-'));
  roots.push(root);
  const line = (n, sep) =>
    `**27** módulos · **${n.replace(/(\d)(\d{3})$/, `$1${sep}$2`)}+** pruebas · **0** telemetría.`;
  const four = {
    'README.md': line('2500', ','),
    'README.en.md': line('2500', ','),
    'README.es.md': line('2500', '.'),
    'README.fr.md': line('2500', ' '),
  };
  for (const [name, text] of Object.entries({ ...four, ...overrides })) writeFileSync(join(root, name), text);
  const log = join(root, 'test.log');
  // 伪 vitest 汇总行（真实形态：前置空白 + 「Tests  N passed (N)」；混排形
  // 取 passed 位不变义——见脚本注释）
  writeFileSync(log, ' Test Files  178 passed (178)\n      Tests  2600 passed (2600)\n');
  return { root, log };
}

/** 一次真跑：CHECK_ROOT 指夹具根，spawnSync 捕 stdout/stderr 与退出码 */
function run(root, log) {
  const r = spawnSync(process.execPath, [join('tools', 'check-test-count.mjs'), log], {
    cwd: ROOT,
    env: { ...process.env, CHECK_ROOT: root },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('check-test-count 机器闸（全面复盘 20260902 G-3④）', () => {
  it('绿路：实测 2600 ≥ 四语下限 2500 → exit 0 带余量披露', () => {
    const { root, log } = fixture();
    const r = run(root, log);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('实测 2600 ≥ README 四语下限 2500（余量 +100）');
  });

  it('绿路（CI 色码形态）：日志带 ANSI 色码 → 剥离后照常提取（CI 三连红回归锁 20260903）', () => {
    const { root, log } = fixture();
    // 仿真 GitHub Actions tee 日志实录形态：chalk 检 CI=true 强制色档，汇总行
    // 数字前插 ESC 序列——`Tests ^[[22m^[[32m2600 passed`，不剥码则「Tests␣␣数字」
    // 正则断在色码上、整锚误报「零汇总行」（公开仓 CI 三连红实证）
    writeFileSync(
      log,
      ' \x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m178 passed\x1b[39m\x1b[22m\x1b[90m (178)\x1b[39m\n' +
        '      \x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m2600 passed\x1b[39m\x1b[22m\x1b[90m (2600)\x1b[39m\n',
    );
    const r = run(root, log);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('实测 2600 ≥ README 四语下限 2500');
  });

  it('红路①下限失真：宣称 3000 > 实测 2600 → exit 1 点名缩测须滚四语', () => {
    const line3000 = '**27** módulos · **3,000+** pruebas · **0** telemetría.';
    const { root, log } = fixture({
      'README.md': line3000,
      'README.en.md': line3000.replace('pruebas', 'tests'),
      'README.es.md': '**27** módulos · **3.000+** pruebas · **0** telemetría.',
      'README.fr.md': '**27** módulos · **3 000+** tests · **0** telemetría.',
    });
    const r = run(root, log);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('实测 2600 < README 下限 3000');
  });

  it('红路②四语不一致：fr 单侧 2600 → exit 1 点名四语下限串', () => {
    const { root, log } = fixture({ 'README.fr.md': '**27** módulos · **2 600+** tests.' });
    const r = run(root, log);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('四语下限互不一致：2500 / 2500 / 2500 / 2600');
  });

  it('红路③宣称面漂移：es 侧无宣称 → exit 1 点名解析失败（锚正则随写法同笔滚）', () => {
    const { root, log } = fixture({ 'README.es.md': 'sin reclamo de recuento de pruebas' });
    const r = run(root, log);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('README.es.md 测试计数下限宣称解析失败');
  });

  it('红路④日志面漂移：零汇总行 → exit 1 点名（防锚被喂空日志静默绿）', () => {
    const { root, log } = fixture();
    writeFileSync(log, 'no summary here\n');
    const r = run(root, log);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('零「Tests  N passed」汇总行');
  });
});
