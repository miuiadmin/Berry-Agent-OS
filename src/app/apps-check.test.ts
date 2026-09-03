/**
 * `berry apps check` 体检面测试（契约篇 §6.13.9，第八十七批批 3）。
 *
 * 官方面 = 真包清单（随包面恒绿的回归锁语义同 api-gate.test.ts——不造夹具）；
 * 第三方/遥测两面 = 临时数据目录夹具（sources.json + 装机物 + rollup.db 全真形）。
 * 退出码契约（0 无断裂 / 1 有断裂）经 appsCheckMain 直测（stdout 截获）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRollupStore } from '../obs/index.js';
import { appsCheckMain, collectAppsCheck, renderAppsCheckReport } from './apps-check.js';

/** 临时数据目录（测试自管——卸载清理） */
const tmpDataDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 造一个隔离数据目录（含 apps/ 子树起点） */
function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'berry-apps-check-'));
  tmpDataDirs.push(dir);
  mkdirSync(join(dir, 'apps'), { recursive: true });
  return dir;
}

/** 第三方清单真值（min 1.0 admit 路 / 去块 legacy 路 / 高 min 断裂路由调用方改写） */
const MANIFEST_OK = `id: acme/probe\nlabel: 探针\ncomponents: [builtin:chat]\napi:\n  minApiVersion: "1.0"\n`;

/** 写装机账本（sources.json——键形 = provenance 键域四形之一） */
function writeLedger(dir: string, ledger: Record<string, unknown>): void {
  writeFileSync(join(dir, 'apps', 'sources.json'), JSON.stringify(ledger, null, 2));
}

/** 装机物落位：root 目录 + 清单内容（缺省 = MANIFEST_OK；无清单场景直接 mkdirSync） */
function placeArtifact(root: string, manifest: string = MANIFEST_OK): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'acme.app.yaml'), manifest);
}

describe('apps check：官方面（真包清单）', () => {
  it('官方清单随包恒绿：apiVersion 1.0 裁决全 ✓/⚠（无断裂）', () => {
    const report = collectAppsCheck({ dataDir: makeDataDir(), hostApiVersion: '1.0' });
    expect(report.hostApiVersion).toBe('1.0');
    // 官方行 = id 非域前缀裸名的行（chat/berrycode 等）；断言面恒非 broken
    const official = report.rows.filter((r) => !r.app.includes('/') && r.app !== '(官方清单面)');
    expect(official.length).toBeGreaterThan(0);
    for (const row of official) expect(['ok', 'warn']).toContain(row.status);
  });
});

describe('apps check：第三方面（sources.json 纯读 + 装机物发现）', () => {
  it('npm 形键 + 合法清单 → ✓ admit 行', () => {
    const dir = makeDataDir();
    placeArtifact(join(dir, 'apps', 'node_modules', 'acme'));
    writeLedger(dir, { 'node_modules/acme': { source: 'npm', ref: 'acme@1.0.0', id: 'acme/probe' } });
    const report = collectAppsCheck({ dataDir: dir, hostApiVersion: '1.0' });
    const row = report.rows.find((r) => r.app === 'acme/probe');
    expect(row?.status).toBe('ok');
    expect(row?.detail).toContain('admit');
  });

  it('git 形键 + min 超宿主 → ✗ 断裂行（API_VERSION_MISMATCH 三段消息原文披露）', () => {
    const dir = makeDataDir();
    placeArtifact(join(dir, 'apps', 'git', 'acme'), MANIFEST_OK.replace('"1.0"', '"9.9"'));
    writeLedger(dir, { 'git/acme': { source: 'git', ref: 'https://example/acme', id: 'acme/probe' } });
    const report = collectAppsCheck({ dataDir: dir, hostApiVersion: '1.0' });
    const row = report.rows.find((r) => r.app === 'acme/probe');
    expect(row?.status).toBe('broken');
    expect(row?.detail).toContain('minApiVersion 9.9');
  });

  it('local 形键（绝对路径）+ 坏清单 → ✗ 断裂行（APP_INVALID 语境）', () => {
    const dir = makeDataDir();
    const artifact = join(dir, 'artifact-local');
    placeArtifact(artifact, 'id: [坏形状\n'); // yaml 解析即炸——归断裂不炸整报
    writeLedger(dir, { [artifact]: { source: 'local', ref: artifact, id: 'acme/probe' } });
    const report = collectAppsCheck({ dataDir: dir, hostApiVersion: '1.0' });
    expect(report.rows.find((r) => r.app === 'acme/probe')?.status).toBe('broken');
  });

  it('装机物无清单 → ⚠ 容忍窗（仓库态件无 api 声明面）；账本在物不在 → ✗ 失联', () => {
    const dir = makeDataDir();
    mkdirSync(join(dir, 'apps', 'node_modules', 'bare'), { recursive: true }); // 无 .app.yaml
    writeLedger(dir, {
      'node_modules/bare': { source: 'npm', ref: 'bare@1.0.0', id: 'acme/bare' },
      'node_modules/ghost': { source: 'npm', ref: 'ghost@1.0.0', id: 'acme/ghost' },
    });
    const report = collectAppsCheck({ dataDir: dir, hostApiVersion: '1.0' });
    expect(report.rows.find((r) => r.app === 'acme/bare')?.status).toBe('warn');
    const ghost = report.rows.find((r) => r.app === 'acme/ghost');
    expect(ghost?.status).toBe('broken');
    expect(ghost?.detail).toContain('失联');
  });

  it('skills/ 键跳过（技能通道非应用）；sources.json 损坏 → ✗ 账本行', () => {
    const dir = makeDataDir();
    placeArtifact(join(dir, 'apps', 'node_modules', 'acme'));
    writeFileSync(
      join(dir, 'apps', 'sources.json'),
      JSON.stringify({ 'skills/some-skill': { source: 'skill', ref: 'x', id: 'some-skill' } }),
    );
    let report = collectAppsCheck({ dataDir: dir, hostApiVersion: '1.0' });
    // skills 键零行——唯一第三方行是 acme 的 ✓（skills 不入体检面）
    expect(report.rows.filter((r) => r.app.startsWith('some-skill'))).toHaveLength(0);

    writeFileSync(join(dir, 'apps', 'sources.json'), '{corrupt json');
    report = collectAppsCheck({ dataDir: dir, hostApiVersion: '1.0' });
    const ledger = report.rows.find((r) => r.app === '(装机账本)');
    expect(ledger?.status).toBe('broken');
    expect(ledger?.detail).toContain('损坏');
  });
});

describe('apps check：废弃遥测面（rollup.db 存在才读）', () => {
  it('缺库零遥测行（零副作用纪律——不建库）', () => {
    const report = collectAppsCheck({ dataDir: makeDataDir(), hostApiVersion: '1.0' });
    expect(report.deprecations).toHaveLength(0);
  });

  it('有库聚合 app × dep + DEP 注册簿 join（现役空册 → 册外编号披露）', () => {
    const dir = makeDataDir();
    // 真形 rollup.db：开库即建（写面在测试——体检面只读）
    const store = openRollupStore(join(dir, 'apps', 'obs', 'rollup.db'));
    const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    store.apply([{ table: 'deprecation', hourTs: T0, dims: ['acme/probe', 'DEP-042'], cols: { uses: 7 } }]);
    store.close();
    const report = collectAppsCheck({ dataDir: dir, hostApiVersion: '1.0' });
    expect(report.deprecations).toHaveLength(1);
    expect(report.deprecations[0]).toMatchObject({ app: 'acme/probe', dep: 'DEP-042', uses: 7 });
    expect(report.deprecations[0]?.entry).toBeUndefined(); // 空册——册外编号
  });
});

describe('apps check：渲染与退出码', () => {
  it('三色行 + 结论行渲染；无断裂 = 退出码 0 / 有断裂 = 退出码 1', () => {
    const dir = makeDataDir();
    placeArtifact(join(dir, 'apps', 'node_modules', 'acme'));
    placeArtifact(join(dir, 'apps', 'node_modules', 'broken-one'), MANIFEST_OK.replace('"1.0"', '"9.9"'));
    writeLedger(dir, {
      'node_modules/acme': { source: 'npm', ref: 'acme@1', id: 'acme/probe' },
      'node_modules/broken-one': { source: 'npm', ref: 'b@1', id: 'acme/broken' },
    });
    const report = collectAppsCheck({ dataDir: dir, hostApiVersion: '1.0' });
    const text = renderAppsCheckReport(report);
    expect(text).toContain('✓ acme/probe');
    expect(text).toContain('✗ acme/broken');
    expect(text).toContain('结论：1 处断裂');

    // 退出码契约：stdout 截获直测 appsCheckMain
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    });
    try {
      expect(appsCheckMain({ dataDir: dir, hostApiVersion: '1.0' })).toBe(1);
      const clean = makeDataDir(); // 仅官方面（随包恒绿）→ 0
      expect(appsCheckMain({ dataDir: clean, hostApiVersion: '1.0' })).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).toContain('应用 API 体检');
  });
});
