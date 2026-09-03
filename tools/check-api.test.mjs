/**
 * check-api 机器闸回归锁（API 治理 §6.13.8，第八十七批批 2 起——查 8 探针与
 * 生成器单测随第九十一批）——check-topology.test.mjs / check-events.test.mjs
 * 同款收编（vitest 窄面 spawn 真脚本 + 纯函数单测，tsc 视门外纯 node 语义直跑）。
 *
 * 层锁：
 * 1. 净树 spawn：八查全绿 exit 0（门禁链占位在岗——脚本被删/依赖断链先在此红）；
 * 2. 查 1 可红探针：CHECK_API_SNAPSHOT env 缝注入篡改快照（tier 改形）→ exit 1
 *    且 stderr 点名 [查 1]——drift 侦测不静默退化（守护炮负例探针纪律）；
 * 3. 查 3/查 4 可红探针：CHECK_API_DEPRECATIONS env 缝注入假注册簿（批 3）——
 *    坏行五红（格式/坐标/窗口/替代/册外标签）+ 真实坐标证明查 4 扫描面执法
 *    （定义点豁免不吞使用点）；
 * 4. 查 8 可红探针（第九十一批）：快照注入多一 export → 查 1（快照 ≠ 真值）与
 *    查 8（生成物 ≠ 渲染真值）双红——seam 联动证明生成物从提交位快照派生；
 * 5. scanTopLevelExports 单测（手写 token 扫描器——含 tsgo 模板幻影陷阱回归锁）；
 * 6. 生成器纯函数单测：classifyFaceDiff 四类分桶 + judgeBreakages 判级携 DEP
 *    语境（sanctioned/MAJOR 分桶——§6.13.6 冷读 M1 语义锁）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanTopLevelExports } from './extract-api-surface.mjs';
import { classifyFaceDiff, compareSemver, judgeBreakages, loadArchivedSnapshots } from './generate-compatibility.mjs';

/** 仓库根（本文件在 tools/ 下） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 被测脚本（cwd=ROOT 相对路径——与本仓门禁同一调用形态） */
const SCRIPT = join('tools', 'check-api.mjs');

describe('check-api 机器闸：净树全绿（八查集成锁）', () => {
  it('spawn 真脚本 exit 0——快照与抽取真值同步 + 生成物与渲染真值同步 + 八查零问题', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
  }, 60_000);
});

describe('check-api 查 3/查 4：废弃登记执法可红探针（CHECK_API_DEPRECATIONS env 缝）', () => {
  /**
   * 缝纪律同查 1：注入假注册簿证查 3/4 可红，不动共享树真身。注入行走全部
   * 五道行不变式 + 注册簿↔面清单对照 + JSDoc 双向 + 查 4 扫描——一次注入多红，
   * 断言取关键消息（contains 语义，多红不互斥）。
   */
  it('坏行注册簿（格式/坐标/窗口/替代全缺 + 册外编号）→ exit 1 且 stderr 点名 [查 3] 各道', () => {
    const dir = mkdtempSync(join(tmpdir(), 'berry-check-api-dep-'));
    const fake = join(dir, 'fake-deprecations.json');
    // 一行五红：dep 格式非法（X-1 非 DEP-三位）/ symbol 单段非坐标形 /
    // 窗口不足（1.0→1.1 < 3 minor）/ replacement 空 / 无 JSDoc 标签对应
    writeFileSync(
      fake,
      JSON.stringify([{ dep: 'X-1', symbol: 'bad', introducedIn: '1.0', removalIn: '1.1', replacement: '' }]),
    );
    try {
      const r = spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CHECK_API_DEPRECATIONS: fake },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 3]');
      expect(r.stderr).toContain('DEP 编号格式非法');
      expect(r.stderr).toContain('两段坐标形');
      expect(r.stderr).toContain('废弃窗不足');
      expect(r.stderr).toContain('replacement 为空');
      expect(r.stderr).toContain('不在面清单');
      expect(r.stderr).toContain('无对应 @deprecated JSDoc 标签');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('真实坐标注入 → [查 4] 官方产码使用废弃面红（定义点豁免不吞使用点）', () => {
    // 坐标取真实面符号（berryagent::AppError）：定义位 errors.ts 经 export 声明
    // 豁免，使用位（apply-patch/pipeline 等全仓）逐文件点名——查 4 扫描面执法证明
    const dir = mkdtempSync(join(tmpdir(), 'berry-check-api-dep-'));
    const fake = join(dir, 'fake-deprecations.json');
    writeFileSync(
      fake,
      JSON.stringify([
        {
          dep: 'DEP-042',
          symbol: 'berryagent::AppError',
          introducedIn: '1.0',
          removalIn: '1.3',
          replacement: 'core/AppError',
        },
      ]),
    );
    try {
      const r = spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CHECK_API_DEPRECATIONS: fake },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 4]');
      expect(r.stderr).toContain('AppError');
      // 定义位豁免证明：errors.ts 自身不进使用红名单
      expect(r.stderr).not.toContain('src/contracts/errors.ts 使用废弃面');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('check-api 查 1：drift 侦测可红探针（CHECK_API_SNAPSHOT env 缝）', () => {
  it('篡改快照一条 tier → exit 1 且 stderr 点名 [查 1] 与重跑指引', () => {
    // 读真快照改一条（stable→experimental）写临时位——只换片不动真身（共享树零并发风险）
    const surface = JSON.parse(readFileSync(join(ROOT, 'src/contracts/api-surface.json'), 'utf8'));
    surface.exports[0].tier = 'experimental';
    const dir = mkdtempSync(join(tmpdir(), 'berry-check-api-'));
    const tampered = join(dir, 'tampered-surface.json');
    writeFileSync(tampered, JSON.stringify(surface, null, 2) + '\n');
    try {
      const r = spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CHECK_API_SNAPSHOT: tampered },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 1]');
      expect(r.stderr).toContain('extract-api-surface.mjs --write');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('check-api 查 1/查 8：快照篡改双红探针（生成物从提交位快照派生）', () => {
  it('快照注入多一 export → 查 1（≠抽取真值）+ 查 8（生成物≠渲染真值）双红', () => {
    // 查 8 的派生源 = 提交位快照（非抽取真值）：篡改快照必联动两查——证明生成物
    // 纪律与快照纪律同链（手改生成物或漏再生单查 8 红，此处验 seam 联动半边）
    const surface = JSON.parse(readFileSync(join(ROOT, 'src/contracts/api-surface.json'), 'utf8'));
    surface.exports.push({
      symbol: 'TAMPERED_EXPORT',
      module: 'berryagent',
      tier: 'stable',
      since: '1.0',
      formFactors: ['standalone'],
    });
    const dir = mkdtempSync(join(tmpdir(), 'berry-check-api-gen-'));
    const tampered = join(dir, 'tampered-surface.json');
    writeFileSync(tampered, JSON.stringify(surface, null, 2) + '\n');
    try {
      const r = spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CHECK_API_SNAPSHOT: tampered },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 1]');
      expect(r.stderr).toContain('TAMPERED_EXPORT');
      expect(r.stderr).toContain('[查 8]');
      expect(r.stderr).toContain('COMPATIBILITY.md 漂移');
      expect(r.stderr).toContain('docs/API参考.md 漂移');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('classifyFaceDiff：两版面 diff 四类分桶（§6.13.6——纯函数）', () => {
  /** 迷你面条目工厂（只带分类涉及的字段） */
  const e = (symbol, module = 'berryagent', tier = 'stable', extra = {}) => ({
    symbol,
    module,
    tier,
    since: '1.0',
    formFactors: ['standalone'],
    ...extra,
  });
  it('added/removed/changed/re-tiered 四桶各归其位（changed 与 re-tiered 互斥）', () => {
    const prev = {
      exports: [
        e('Keep'),
        e('Gone'),
        e('Shape', 'berryagent', 'stable', { since: '1.0', formFactors: ['standalone', 'daemon'] }),
        e('Flip', 'berryagent', 'stable'),
      ],
      capabilities: [],
    };
    const curr = {
      exports: [
        e('Keep'),
        e('New'),
        e('Shape', 'berryagent', 'stable', { since: '1.1', formFactors: ['standalone', 'daemon'] }),
        e('Flip', 'berryagent', 'experimental'),
      ],
      capabilities: [],
    };
    const diff = classifyFaceDiff(prev, curr);
    expect(diff.added).toEqual(['berryagent::New']);
    expect(diff.removed).toEqual(['berryagent::Gone']);
    expect(diff.changed).toEqual(['berryagent::Shape']); // since 变 = 改形
    expect(diff.reTiered).toEqual([{ key: 'berryagent::Flip', from: 'stable', to: 'experimental' }]); // 仅 tier 变 = 重定级
    expect(diff.capabilitiesChanged).toBe(false);
  });
  it('capabilities 增删单独成旗（不进 exports 四桶）', () => {
    const diff = classifyFaceDiff(
      { exports: [e('Only')], capabilities: [{ name: 'web.fetch' }] },
      { exports: [e('Only')], capabilities: [{ name: 'web.fetch' }, { name: 'memory.store' }] },
    );
    expect(diff.added).toEqual([]);
    expect(diff.capabilitiesChanged).toBe(true);
  });
});

describe('judgeBreakages：判级携 DEP 语境（§6.13.6 冷读 M1——机器认登记不认动机）', () => {
  const deps = [
    { dep: 'DEP-001', symbol: 'berryagent::Due', removalIn: '1.2' },
    { dep: 'DEP-002', symbol: 'berryagent::NotDue', removalIn: '1.9' },
  ];
  it('死期已到 = sanctioned 销账桶；死期未到/无 DEP = MAJOR 桶', () => {
    const verdict = judgeBreakages(
      ['berryagent::Due', 'berryagent::NotDue', 'berryagent::Wild'],
      'removed',
      deps,
      '1.3.0',
    );
    expect(verdict.sanctioned).toEqual([{ key: 'berryagent::Due', dep: 'DEP-001' }]);
    expect(verdict.major).toEqual(['berryagent::NotDue', 'berryagent::Wild']);
  });
  it('版本比较逐段数值（1.10 > 1.9——字典序假阳在此红）', () => {
    // removalIn 1.9 对 1.10.0：数值序已到死期 = sanctioned；字典序会误判未到
    const verdict = judgeBreakages(
      ['berryagent::Due'],
      'removed',
      [{ dep: 'DEP-003', symbol: 'berryagent::Due', removalIn: '1.9' }],
      '1.10.0',
    );
    expect(verdict.sanctioned).toEqual([{ key: 'berryagent::Due', dep: 'DEP-003' }]);
    expect(verdict.major).toEqual([]);
  });
});

describe('compareSemver / loadArchivedSnapshots：归档族排序（第九十一批——字典序两大陷阱锁）', () => {
  it('compareSemver：预发布 < 正式版、预发布段数值序（alpha.2 < alpha.10、rc 后于 alpha）', () => {
    // 陷阱一：'1.0.0' 是 '1.0.0-alpha.1' 前缀，字典序反排正式版在前；
    // 陷阱二：localeCompare 默认不开 numeric collation，'alpha.10' 字典序先于 'alpha.2'
    const order = ['1.0.0-alpha.2', '1.0.0-alpha.10', '1.0.0-rc.1', '1.0.0', '1.0.1'];
    expect([...order].reverse().sort(compareSemver)).toEqual(order);
  });
  it('loadArchivedSnapshots(dir)：目录参数化 + 版本号 semver 升序 + 缺席目录空数组', () => {
    // dir 参数化供 release 子步 3.5 以 workDir 锚定位复用（真跑同根、测试临时位）
    const dir = mkdtempSync(join(tmpdir(), 'berry-archived-snaps-'));
    try {
      const e = (symbol) => ({
        symbol,
        module: 'berryagent',
        tier: 'stable',
        since: '1.0',
        formFactors: ['standalone'],
      });
      // 落盘序故意乱序（正式版先落、alpha.10 先于 alpha.2）——读取序必须纠正
      for (const [v, n] of [
        ['1.0.0', 1],
        ['1.0.0-alpha.10', 10],
        ['1.0.0-alpha.2', 2],
      ]) {
        writeFileSync(
          join(dir, `${v}.json`),
          JSON.stringify({
            apiVersion: '1.0',
            exports: Array.from({ length: n }, (_, i) => e(`S${i}`)),
            capabilities: [],
          }),
        );
      }
      const snaps = loadArchivedSnapshots(dir);
      expect(snaps.map((s) => s.version)).toEqual(['1.0.0-alpha.2', '1.0.0-alpha.10', '1.0.0']);
      expect(snaps[0].surface.exports).toHaveLength(2); // 内容随文件名正确配对
      expect(loadArchivedSnapshots(join(dir, 'absent'))).toEqual([]); // 缺席目录 = 基线形成前
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scanTopLevelExports：手写扫描器单测（tsgo unstable/ast 依赖面回归锁）', () => {
  it('export 声明五形全收：const/function/class/interface/type/enum + 具名清单', () => {
    const src = [
      'export const alpha = 1;',
      'export function beta() {}',
      'export class Gamma {}',
      'export interface Delta {}',
      'export type Epsilon = string;',
      'export enum Zeta {}',
      'export { eta, theta as iota } from "./other.js";',
      'export * from "./star.js";',
      'export * as ns from "./ns.js";',
      'const internal = 0; // 非导出不收',
    ].join('\n');
    const scan = scanTopLevelExports(src);
    expect([...scan.names.keys()]).toEqual(
      expect.arrayContaining(['alpha', 'beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'eta', 'iota']),
    );
    expect(scan.names.has('internal')).toBe(false);
    expect(scan.stars).toEqual(['./star.js', './ns.js']);
  });

  it('tsgo 模板幻影陷阱：`${}` 插值后的代码大括号不被吞（templateStack 协议回归锁）', () => {
    // 无协议的独立 scanner：插值闭 } 后扫描器停在幻影模板头，后续 export 声明的
    // 大括号全被当模板文本吞掉——本测的 export afterTemplate 必须仍被扫到
    const src = [
      'const tpl = `a${ { x: 1 } }b`;',
      'export const afterTemplate = 2;',
      'const tpl2 = `open${1}`;',
      'export const alsoAfter = 3;',
      'export function withBraces() { return { deep: `t${2}` }; }',
      'export const tail = 4;',
    ].join('\n');
    const scan = scanTopLevelExports(src);
    expect(scan.names.has('afterTemplate')).toBe(true);
    expect(scan.names.has('alsoAfter')).toBe(true);
    expect(scan.names.has('withBraces')).toBe(true);
    expect(scan.names.has('tail')).toBe(true);
  });

  it('嵌套大括号零深度漂移：对象字面量/枚举体/命名空间内的标识符不误判为顶层', () => {
    const src = [
      'export const obj = { notExport: 1, nested: { deep: 2 } };',
      'const plain = { fakeExport: 3 };',
      'export const last = 4;',
    ].join('\n');
    const scan = scanTopLevelExports(src);
    expect(scan.names.has('obj')).toBe(true);
    expect(scan.names.has('last')).toBe(true);
    expect(scan.names.has('plain')).toBe(false); // 模块深度内（顶层 const 非导出）
    expect(scan.names.has('notExport')).toBe(false);
    expect(scan.names.has('fakeExport')).toBe(false);
  });

  it('declare/abstract/async 修饰前缀穿透（.d.ts 形与异步形）', () => {
    const src = [
      'declare function dec(): void;',
      'export declare const declared = 1;',
      'export abstract class Abs {}',
      'export async function afn() {}',
    ].join('\n');
    const scan = scanTopLevelExports(src);
    expect(scan.names.has('declared')).toBe(true);
    expect(scan.names.has('Abs')).toBe(true);
    expect(scan.names.has('afn')).toBe(true);
    expect(scan.names.has('dec')).toBe(false); // declare 未 export 不收
  });
});
