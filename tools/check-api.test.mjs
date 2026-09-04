/**
 * check-api 机器闸回归锁（API 治理 §6.13.8，第八十七批批 2 起——查 8 探针与
 * 生成器单测随第九十一批）——check-topology.test.mjs / check-events.test.mjs
 * 同款收编（vitest 窄面 spawn 真脚本 + 纯函数单测，tsc 视门外纯 node 语义直跑）。
 *
 * 层锁：
 * 1. 净树 spawn：十查全绿 exit 0（门禁链占位在岗——脚本被删/依赖断链先在此红）；
 * 2. 查 1 可红探针：CHECK_API_SNAPSHOT env 缝注入篡改快照（tier 改形）→ exit 1
 *    且 stderr 点名 [查 1]——drift 侦测不静默退化（守护炮负例探针纪律）；
 * 3. 查 3/查 4 可红探针：CHECK_API_DEPRECATIONS env 缝注入假注册簿（批 3）——
 *    坏行五红（格式/坐标/窗口/替代/册外标签）+ 真实坐标证明查 4 扫描面执法
 *    （定义点豁免不吞使用点）；
 * 4. 查 8 可红探针（第九十一批）：快照注入多一 export → 查 1（快照 ≠ 真值）与
 *    查 8（生成物 ≠ 渲染真值）双红——seam 联动证明生成物从提交位快照派生；
 * 5. scanTopLevelExports 单测（手写 token 扫描器——含 tsgo 模板幻影陷阱回归锁）；
 * 6. 生成器纯函数单测：classifyFaceDiff 四类分桶 + judgeBreakages 判级携 DEP
 *    语境（sanctioned/MAJOR 分桶——§6.13.6 冷读 M1 语义锁）；
 * 7. 扫描侧可红探针（就绪度审计 20260903 P1）：CHECK_API_ROOT 夹具树缝 +
 *    CHECK_API_SURFACE 面注入缝——查 2 tier 三支与自由符号 / 查 3c 两方向 /
 *    查 5 实验隔离 / 查 6 compat / 查 7 两形态各得负例（原本硬锚真树恒绿
 *    不可证伪）；夹具基线先证 exit 0（红归因前提——基线不净红即夹具噪音非探针命中）；
 * 8. 查 9 面动号不动可红探针（就绪度审计 20260903 P2）：CHECK_API_ARCHIVES
 *    归档族缝 + CHECK_API_SNAPSHOT 快照缝——ignited + 面 diff + 号未 bump 红；
 *    号已 bump / 纪元 pre-ignition / 归档族空三休眠形不红（机制常驻休眠语义锁）。
 * 9. 查 10 公开产物指路卫生可红探针（API 治理进化刀 J）：CHECK_API_ROOT 夹具树
 *    缝——文件面（COMPATIBILITY / api-decls）与 contracts API_ 消息面各得负例；
 *    非 API_ 族消息与产码注释指路不红（§6.13.8 查 10 面界锁——机器面只审
 *    API_ 族运行时字符串，APP_ 族同形清扫靠笔不靠闸）。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  descFromJsdoc,
  firstPublicSentence,
  scanTopLevelExports,
  sliceInterfaceMembers,
  sliceInterfaceMembersDetailed,
} from './extract-api-surface.mjs';
import { EXPERIMENTAL_SECTION_HEADING, KNOWLEDGE_DOMAIN_RE, stripExperimentalSection } from './api-doc-sections.mjs';
import { renderApiReference } from './generate-api-reference.mjs';
import {
  classifyFaceDiff,
  compareSemver,
  eraOf,
  judgeBreakages,
  loadArchivedSnapshots,
  renderCompatibility,
} from './generate-compatibility.mjs';

/** 仓库根（本文件在 tools/ 下） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 被测脚本（cwd=ROOT 相对路径——与本仓门禁同一调用形态） */
const SCRIPT = join('tools', 'check-api.mjs');

describe('check-api 机器闸：净树全绿（十查集成锁）', () => {
  it('spawn 真脚本 exit 0——快照与抽取真值同步 + 生成物与渲染真值同步 + 十查零问题', () => {
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

/**
 * 夹具树基线（CHECK_API_ROOT 的消费前提）：查 2 barrel 读 / 查 7 apps 目录与
 * package.json 读是无条件面——夹具根缺任一即脚本 crash 先于出口（problems
 * 永不落 stderr，断言必空）。基线三件全绿形：纯星出 barrel（scanTopLevelExports
 * 只收直导出——星出走 stars 不进 names）/ 带 api 块合法清单 / apiVersion 1.0。
 * 每探针在基线上只注入一处违规——红归因唯一（守护炮负例探针纪律）。
 * 脚本侧真值（jiti 载真契约面 / 生成器真值 / 真注册簿）恒走真仓不随缝移——
 * 注入侧只动扫描树与面清单（check-api.mjs 顶注缝契约）。
 * 模块级共享（API 治理进化刀 J 起）：查 10 探针（公开产物指路卫生）同缝复用。
 */
function makeFixtureRoot() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'berry-check-api-root-')));
  mkdirSync(join(root, 'src/contracts'), { recursive: true });
  writeFileSync(join(root, 'src/contracts/index.ts'), "export * from './fixture-face.js';\n");
  mkdirSync(join(root, 'apps'));
  writeFileSync(
    join(root, 'apps/zz-fixture.app.yaml'),
    'id: vendor/zz\nlabel: 夹具\ncomponents:\n  - builtin:chat\napi:\n  minApiVersion: "1.0"\n',
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ apiVersion: '1.0' }, null, 2) + '\n');
  return root;
}

/** spawn 门禁（env 缝注入 + 仓库 cwd——与门禁链同一调用形态）；模块级共享（查 10 探针同缝复用） */
const runGate = (extraEnv) =>
  spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });

describe('check-api 扫描侧可红探针（CHECK_API_ROOT / CHECK_API_SURFACE 双缝——就绪度审计 20260903 P1）', () => {
  it('夹具基线净树 exit 0——扫描侧六查在夹具根全绿（后续红 = 探针注入归因唯一）', () => {
    const root = makeFixtureRoot();
    try {
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 2 tier 三支可红（面注入缝）：tier 非法 + 缺 since + 缺 formFactors 一次三红，且查 1 注入即跳过', () => {
    // CHECK_API_SURFACE 注入面清单（extractSurface 产物形）——查 1 drift 面恒走
    // 真册，注入时整块跳过（stderr 无 [查 1] 是跳过语义的断言面）
    const dir = mkdtempSync(join(tmpdir(), 'berry-check-api-surface-'));
    const fake = join(dir, 'fake-surface.json');
    writeFileSync(
      fake,
      JSON.stringify({
        exports: [{ symbol: 'zzFake', module: 'zz/fixture', tier: 'banana', since: '', formFactors: [] }],
        capabilities: [],
      }),
    );
    try {
      const r = runGate({ CHECK_API_SURFACE: fake });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 2]');
      expect(r.stderr).toContain('tier 非法');
      expect(r.stderr).toContain('缺 since');
      expect(r.stderr).toContain('缺 formFactors');
      expect(r.stderr).not.toContain('[查 1]'); // 注入面不是 drift 真值——查 1 整块跳过
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 2 since 坐标不变式可红（面注入缝）：since > apiVersion 未来版本号入册即红，等于/过去均零红（API 治理进化刀 F）', () => {
    // 不变式（契约篇 §6.13.8 查 2 增设——版本坐标系双向收口）：任一条目
    // since > 当前 apiVersion 即红——since/removalIn 是 DEP 窗口算术（3 minor）
    // 的坐标基准，查 9 只执法「面动号不动」单向半边，本探针锁反方向可红性。
    // 三腿一次验全：zzFuture（2.0 > 1.0）必红；zzCurrent（等于）与
    // zzPast（过去）为控制腿——边界上「等于」不算超。
    const dir = mkdtempSync(join(tmpdir(), 'berry-check-api-surface-'));
    const fake = join(dir, 'fake-surface.json');
    writeFileSync(
      fake,
      JSON.stringify({
        apiVersion: '1.0',
        exports: [
          { symbol: 'zzFuture', module: 'zz/fixture', tier: 'stable', since: '2.0', formFactors: ['standalone'] },
          { symbol: 'zzCurrent', module: 'zz/fixture', tier: 'stable', since: '1.0', formFactors: ['standalone'] },
          { symbol: 'zzPast', module: 'zz/fixture', tier: 'stable', since: '0.9', formFactors: ['standalone'] },
        ],
        capabilities: [],
      }),
    );
    try {
      const r = runGate({ CHECK_API_SURFACE: fake });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 2]');
      expect(r.stderr).toContain('zzFuture');
      expect(r.stderr).not.toContain('zzCurrent'); // 控制腿：since === apiVersion 合法
      expect(r.stderr).not.toContain('zzPast'); // 控制腿：历史 since 合法
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 2 自由符号半边可红：公开根直导出无 JSDoc 标级 → exit 1 点名符号', () => {
    const root = makeFixtureRoot();
    try {
      // 基线 barrel 追加一条顶层直导出（无 @stable 标签）——自由符号现役为零，
      // 闸守新增：直导出必带标级载体
      writeFileSync(
        join(root, 'src/contracts/index.ts'),
        "export * from './fixture-face.js';\nexport const zzFree = 1;\n",
      );
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 2]');
      // 逐符号执法（20260904 #4 腿3）：文案点名具体符号——不再是文件级整述
      expect(r.stderr).toContain('公开根直导出 zzFree 无');
      expect(r.stderr).toContain('zzFree');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 2 自由符号半边逐符号执法：tagged+untagged 并存只红无标签者（遗漏大扫 20260904 #4 腿3——一签遮全文件修死）', () => {
    const root = makeFixtureRoot();
    try {
      // 混合形：zzTagged 带标签 + zzUntagged 无标签——修前文件级 tagged 探测
      // 一签遮全文件（exit 0 静默放行）；修后逐符号点名 zzUntagged
      writeFileSync(
        join(root, 'src/contracts/index.ts'),
        "export * from './fixture-face.js';\n/** @experimental */\nexport const zzTagged = 1;\nexport const zzUntagged = 2;\n",
      );
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('zzUntagged');
      expect(r.stderr).not.toContain('zzTagged');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 2 自由符号半边可红（花括清单形）：export { x } 无 from 无标签 → exit 1 点名符号（第十一轮 A5）', () => {
    const root = makeFixtureRoot();
    try {
      // 花括清单无 from = 本地声明形直导出（头注形态分类「local」列）——修前该
      // 形收名不收标签：查 2 barrelScan.tags 无键不红、freeSymbolTier 走
      // undefined 分支静默落键级 stable，双闸均漏（端到端实证：追加此形后
      // check-api exit=0）
      writeFileSync(
        join(root, 'src/contracts/index.ts'),
        "export * from './fixture-face.js';\nconst zzBraced = 1;\nexport { zzBraced };\n",
      );
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 2]');
      expect(r.stderr).toContain('zzBraced');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 3 扫描面不穿透符号链接：linked 目录不入 walkFiles 面（遗漏大扫 20260904 #13——兑现「不跟随」注释）', () => {
    const root = makeFixtureRoot();
    const outside = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'berry-outside-')));
    try {
      // 扫描根之外的目录放裸 @deprecated 标签文件——只有穿透符号链才会命中
      // [查 3]（修前 statSync 跟随 → src/linked/legacy.ts 入扫描面）
      writeFileSync(join(outside, 'legacy.ts'), '/** @deprecated 旧物 */\nexport const zzLegacy = 1;\n');
      symlinkSync(outside, join(root, 'src', 'linked'));
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('src/linked');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 5 实验面隔离可红（双缝）：experimental 符号漏进 docs/ → exit 1 点名坐标', () => {
    // 面注入供实验符号源，夹具树供 docs/ 扫描面——双缝各司一侧
    const root = makeFixtureRoot();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/guide.md'), '# 指南\n\n先试用 zzFutureThing。\n');
    const dir = mkdtempSync(join(tmpdir(), 'berry-check-api-surface-'));
    const fake = join(dir, 'fake-surface.json');
    writeFileSync(
      fake,
      JSON.stringify({
        exports: [
          {
            symbol: 'zzFutureThing',
            module: 'berryagent',
            tier: 'experimental',
            since: '1.0',
            formFactors: ['standalone'],
          },
        ],
        capabilities: [],
      }),
    );
    try {
      const r = runGate({ CHECK_API_ROOT: root, CHECK_API_SURFACE: fake });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 5]');
      expect(r.stderr).toContain('漏进稳定文档');
      expect(r.stderr).toContain('zzFutureThing');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('【回归锁 进化批 M7】查 5 扫描面含根 README：experimental 符号漏进 README.md → 红（公开面第一入口原本不在扫描面）', () => {
    // 修前形态：docFiles = docs/ + examples/——根 README 四语全在面外，实验符号
    // 漏进第一入口不红；夹具根无 docs/（README 是唯一文档面——归因唯一）
    const root = makeFixtureRoot();
    writeFileSync(join(root, 'README.md'), '# 夹具\n\n先试用 zzFutureThing。\n');
    const dir = mkdtempSync(join(tmpdir(), 'berry-check-api-surface-'));
    const fake = join(dir, 'fake-surface.json');
    writeFileSync(
      fake,
      JSON.stringify({
        exports: [
          {
            symbol: 'zzFutureThing',
            module: 'berryagent',
            tier: 'experimental',
            since: '1.0',
            formFactors: ['standalone'],
          },
        ],
        capabilities: [],
      }),
    );
    try {
      const r = runGate({ CHECK_API_ROOT: root, CHECK_API_SURFACE: fake });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 5]');
      expect(r.stderr).toContain('README.md');
      expect(r.stderr).toContain('zzFutureThing');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('【回归锁 进化批 M7】查 3c 扫描面含根 README 与 api-decls：册外 DEP 标签 + 裸标签双红（手稳件标签与第一入口原本不在对照面）', () => {
    // 两腿一次验全：README.md 带编号但真册零在册（册外腿）；api-decls/x.d.ts
    // 裸标签无编号（无法对账腿）——修前两文件均在 jsdocFiles 面外不可见
    const root = makeFixtureRoot();
    writeFileSync(join(root, 'README.md'), '# 夹具\n\n/** @deprecated DEP-042 未登记 */\n');
    mkdirSync(join(root, 'api-decls'));
    writeFileSync(
      join(root, 'api-decls/zz-hand.d.ts'),
      '/** 手稳件声明 */\n/** @deprecated */\nexport declare const zzOld: number;\n',
    );
    try {
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 3]');
      expect(r.stderr).toContain('DEP-042 未在 DEP 注册簿登记');
      expect(r.stderr).toContain('api-decls/zz-hand.d.ts');
      expect(r.stderr).toContain('裸 @deprecated 标签');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 5 豁免节内合法：实验符号只现于「实验面」节 → exit 0（刀 E 互锁死结回归锁——修前查 5 无豁免位，生成器一按规范渲染实验符号即恒红）', () => {
    // 夹具文档 = 生成器落盘形态：实验符号只出现在文末实验面节内（节标记常量
    // 与生成器共享单源——豁免界两端结构性同源）
    const root = makeFixtureRoot();
    mkdirSync(join(root, 'docs'));
    writeFileSync(
      join(root, 'docs/API参考.md'),
      `# API 参考\n\n## zzModule\n\n- 稳定行\n\n## 能力面（capabilities）\n\n- 无\n\n${EXPERIMENTAL_SECTION_HEADING}\n\n- \`zzFutureThing\`（\`berryagent\`） — experimental，since 1.1，standalone\n`,
    );
    const dir = mkdtempSync(join(tmpdir(), 'berry-check-api-surface-'));
    const fake = join(dir, 'fake-surface.json');
    writeFileSync(
      fake,
      JSON.stringify({
        exports: [
          {
            symbol: 'zzFutureThing',
            module: 'berryagent',
            tier: 'experimental',
            since: '1.0',
            formFactors: ['standalone'],
          },
        ],
        capabilities: [],
      }),
    );
    try {
      const r = runGate({ CHECK_API_ROOT: root, CHECK_API_SURFACE: fake });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 5 豁免不放宽：同文件节外泄漏仍红（strip 只剥节——执法面不随豁免收窄）', () => {
    // 与上一探针同一夹具文档，唯一变量 = 实验符号另现于稳定节一行（红归因唯一
    // ——豁免位只救节内披露，节外泄漏照点名）
    const root = makeFixtureRoot();
    mkdirSync(join(root, 'docs'));
    writeFileSync(
      join(root, 'docs/API参考.md'),
      `# API 参考\n\n## zzModule\n\n- 也可先试用 zzFutureThing\n\n## 能力面（capabilities）\n\n- 无\n\n${EXPERIMENTAL_SECTION_HEADING}\n\n- \`zzFutureThing\`（\`berryagent\`） — experimental，since 1.1，standalone\n`,
    );
    const dir = mkdtempSync(join(tmpdir(), 'berry-check-api-surface-'));
    const fake = join(dir, 'fake-surface.json');
    writeFileSync(
      fake,
      JSON.stringify({
        exports: [
          {
            symbol: 'zzFutureThing',
            module: 'berryagent',
            tier: 'experimental',
            since: '1.0',
            formFactors: ['standalone'],
          },
        ],
        capabilities: [],
      }),
    );
    try {
      const r = runGate({ CHECK_API_ROOT: root, CHECK_API_SURFACE: fake });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 5]');
      expect(r.stderr).toContain('漏进稳定文档');
      expect(r.stderr).toContain('zzFutureThing');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 6 compat 死期可红：src/compat/ 在场即结构性拒绝（批 4 点火前 fail-closed）', () => {
    const root = makeFixtureRoot();
    try {
      mkdirSync(join(root, 'src/compat'));
      writeFileSync(join(root, 'src/compat/legacy-bridge.ts'), 'export const legacyBridge = 1;\n');
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 6]');
      expect(r.stderr).toContain('src/compat');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 7 可红（legacy 形）：清单缺 api 块 → exit 1（回填 api.minApiVersion 即绿的指引文案）', () => {
    const root = makeFixtureRoot();
    try {
      writeFileSync(
        join(root, 'apps/zz-fixture.app.yaml'),
        'id: vendor/zz\nlabel: 夹具\ncomponents:\n  - builtin:chat\n',
      );
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 7]');
      expect(r.stderr).toContain('缺 api 块');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 7 可红（空目录形）：apps/ 零 .app.yaml → exit 1（仓库布局异常防退化）', () => {
    const root = makeFixtureRoot();
    try {
      rmSync(join(root, 'apps/zz-fixture.app.yaml'));
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 7]');
      expect(r.stderr).toContain('零 .app.yaml');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('【回归锁 进化批 M10】查 7 目录缺席 = 红条目而非脚本崩（ENOENT 不吞九查其余结果）', () => {
    // 修前形态：readdirSync(apps/) 无 existsSync 守卫——目录缺席直接 crash，
    // problems 收口永不执行（stderr 无任何 [查 N] 条目、exit 码非 0/1 语义）
    const root = makeFixtureRoot();
    try {
      rmSync(join(root, 'apps'), { recursive: true, force: true });
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1); // 干净红（problems 收口出口）而非 crash 码
      expect(r.stderr).toContain('[查 7]');
      expect(r.stderr).toContain('零 .app.yaml');
      expect(r.stderr).not.toContain('ENOENT'); // 崩闸痕迹不得在场
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('【回归锁 进化批刀 O】查 7 拒载形不炸闸：min 超宿主 → [查 7] 优雅红（修前裸调崩闸——AppError 栈迹吞九查其余结果）', () => {
    // 修前形态（2026-09-04 演练机器首跑抓到）：adjudicateApiGate 以 throw 表达
    // 拒载，查 7 裸调让 min 超宿主直接炸掉 check-api 进程——点名的 [查 7] 红条目
    // 反而不产。修后以 AppError 码判转优雅红；缺块 ignited 态同形（两腿同修）
    const root = makeFixtureRoot();
    try {
      // api 块在场但 min 远超夹具宿主 apiVersion 1.0——两态共通拒载形（不依赖点火位）
      writeFileSync(
        join(root, 'apps/zz-fixture.app.yaml'),
        'id: vendor/zz\nlabel: 夹具\ncomponents:\n  - builtin:chat\napi:\n  minApiVersion: "99.0"\n',
      );
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1); // 干净红（problems 收口出口）而非崩闸
      expect(r.stderr).toContain('[查 7]');
      expect(r.stderr).toContain('API_VERSION_MISMATCH'); // 码判可见（细则④）
      expect(r.stderr).toContain('99.0'); // 拒载 message 点名清单声明的 min
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('【回归锁 进化批 M10】查 7 扫描面 = apps/ 递归 walk：嵌套清单缺 api 块同红且红条目点名嵌套路径', () => {
    // 修前形态：单层 readdirSync 漏嵌套清单——嵌套形不可见即不可红（过查 7 门
    // 却在 release crater 试跑面缺席）；递归 walk 与查 3c 同一 walkFiles 函数
    const root = makeFixtureRoot();
    try {
      mkdirSync(join(root, 'apps/nested'));
      writeFileSync(
        join(root, 'apps/nested/zz-deep.app.yaml'),
        'id: vendor/deep\nlabel: 嵌套\ncomponents:\n  - builtin:chat\n', // 缺 api 块
      );
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 7]');
      // 红条目点名嵌套相对路径（apps/nested/zz-deep.app.yaml）——定位直达
      expect(r.stderr).toContain('apps/nested/zz-deep.app.yaml');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('查 3c 两方向可红：裸 @deprecated 标签 + 册外 DEP 编号标签 → 双红（真注册簿零在册无噪音）', () => {
    const root = makeFixtureRoot();
    try {
      // a.ts 裸标签（无编号无法对账）；b.ts 带编号但真册零在册——两方向各红
      writeFileSync(join(root, 'src/a.ts'), '/** @deprecated */\nexport const zzOld = 1;\n');
      writeFileSync(join(root, 'src/b.ts'), '/** @deprecated DEP-999 登记先行 */\nexport const zzNew = 2;\n');
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 3]');
      expect(r.stderr).toContain('裸 @deprecated 标签未携带 DEP 编号');
      expect(r.stderr).toContain('DEP-999 未在 DEP 注册簿登记');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('check-api 查 9：面动号不动可红探针（CHECK_API_ARCHIVES 归档族缝 + 快照缝——就绪度审计 20260903 P2）', () => {
  /**
   * 缝纪律同查 1：注入夹具归档族 + 注入快照证查 9 可红，不动真归档位（真位
   * 现役为空——基线形成前恒休眠）。注入快照同途触发查 1/查 8 红属预期噪音
   * （快照缝的既定联动），断言只取 [查 9] 在场/缺席。
   */
  /** 迷你面快照工厂（n 条导出——n 变即面 diff；apiVersion/enforcement 逐探针覆写） */
  const face = (n, over = {}) => ({
    apiVersion: '1.0',
    enforcement: 'ignited',
    exports: Array.from({ length: n }, (_, i) => ({
      symbol: `Sym${i}`,
      module: 'berryagent',
      tier: 'stable',
      since: '1.0',
      formFactors: ['standalone'],
    })),
    capabilities: [],
    ...over,
  });

  /** 建夹具（归档族一版 + 当前快照注入位），返回 spawn 结果 */
  const runArchives = (archiveSurface, snapshotSurface) => {
    const dir = mkdtempSync(join(tmpdir(), 'berry-check-api-arch-'));
    const archives = join(dir, 'snapshots');
    mkdirSync(archives, { recursive: true });
    if (archiveSurface !== null) writeFileSync(join(archives, '1.0.0.json'), JSON.stringify(archiveSurface));
    const snap = join(dir, 'current-surface.json');
    writeFileSync(snap, JSON.stringify(snapshotSurface, null, 2) + '\n');
    try {
      return spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CHECK_API_ARCHIVES: archives, CHECK_API_SNAPSHOT: snap },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('ignited + 面增一条 + 号未 bump → exit 1 且 stderr 点名 [查 9] 与 bump 指引', () => {
    const r = runArchives(face(1), face(2));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[查 9]');
    expect(r.stderr).toContain('面动号不动');
    expect(r.stderr).toContain('1.0.0');
    expect(r.stderr).toContain('apiVersion');
  }, 60_000);

  it('三休眠形不红：号已 bump / 纪元 pre-ignition / 归档族空（机制常驻休眠语义锁）', () => {
    // ① 号已 bump：面 diff 在而 apiVersion 1.0 → 1.1，坐标有锚——合法演进
    const bumped = runArchives(face(1), face(2, { apiVersion: '1.1' }));
    expect(bumped.stderr).not.toContain('[查 9]');
    // ② 纪元休眠：pre-ignition 窗口容忍态（面/号自由——点火日即执法日）
    const dormant = runArchives(face(1, { enforcement: 'pre-ignition' }), face(2, { enforcement: 'pre-ignition' }));
    expect(dormant.stderr).not.toContain('[查 9]');
    // ③ 基线休眠：归档族空（首 release 前）无比较基准
    const baseline = runArchives(null, face(2));
    expect(baseline.stderr).not.toContain('[查 9]');
  }, 120_000);
});

describe('check-api 查 10：公开产物指路卫生可红探针（CHECK_API_ROOT 夹具树缝——API 治理进化刀 J）', () => {
  /**
   * 面界（§6.13.8 查 10）：文件面 = COMPATIBILITY.md + docs/API参考.md +
   * api-decls/*（随包分发件——SCAN_ROOT 相对，夹具树可证红）；message 面 =
   * contracts 源内 API_ 族 AppError 字面量（词法提取注释免疫）。修前真树 7 红
   * （4 文件面 + 3 消息面）已由本批落码清扫——本探针锁「可红性」与「面界」：
   * 生成器将来把知识域指路渲回头注 / 新 API_ 消息带篇名引用，闸当场红。
   */
  it('双面可红：COMPATIBILITY 指路 + api-decls 指路 + API_ 消息指路 → 三红点名', () => {
    const root = makeFixtureRoot();
    try {
      // 文件面两腿：生成物头注形（「语义权威 = 设计文档…」）+ 随包分发件头注形
      writeFileSync(
        join(root, 'COMPATIBILITY.md'),
        '# API 兼容性档案\n\n> 语义权威 = 设计文档「应用契约与扩展点」。\n',
      );
      mkdirSync(join(root, 'api-decls'));
      writeFileSync(join(root, 'api-decls/zz-probe.d.ts'), '/** 虚拟模块类型面（API 治理 §6.13.9） */\n');
      // message 面一腿：API_ 族 AppError 消息字面量带知识域篇名（多行 concat 形
      // ——与产码同形，词法提取器按实参区收集）
      writeFileSync(
        join(root, 'src/contracts/zz-probe.ts'),
        [
          'export function probe(appId: string): void {',
          '  throw new AppError(',
          '    API_VERSION_MISMATCH,',
          '    `应用 ${appId} 清单缺 api 块——` +',
          '      `须补声明（契约篇 §6.13.4）。`,',
          '  );',
          '}',
        ].join('\n'),
      );
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[查 10]');
      expect(r.stderr).toContain('COMPATIBILITY.md 指路知识域');
      expect(r.stderr).toContain('api-decls/zz-probe.d.ts 指路知识域');
      expect(r.stderr).toContain('API_VERSION_MISMATCH 错误消息指路知识域');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('面界纪律不放宽：非 API_ 族消息（APP_INVALID）与产码注释指路均不红（机器面只审 API_ 族运行时字符串）', () => {
    const root = makeFixtureRoot();
    try {
      // 同文件三形态并存：注释里的篇名引用（合法）/ APP_ 族消息带篇名（面外——
      // 同形清扫靠笔不靠闸）/ API_ 族消息干净（公开锚形）——三形态全不红
      writeFileSync(
        join(root, 'src/contracts/zz-clean.ts'),
        [
          '// 清单校验语义见契约篇 §6.13.4（产码注释引用规范合法——查 10 面界）',
          'export function probe(where: string): void {',
          '  throw new AppError(APP_INVALID, `${where}：非法清单（见契约篇 §6.13.4）`);',
          '}',
          'export function probe2(v: string): string {',
          '  return `apiVersion 格式非法：${v}（API 治理语义见 docs/应用开发指南.md「API 稳定性与兼容性」节）`;',
          '}',
        ].join('\n'),
      );
      const r = runGate({ CHECK_API_ROOT: root });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
  it('DEP 登记日（tier→deprecated + 载荷挂上）归 re-tiered 桶不归 changed——治理动作非形状变更', () => {
    // 回归锁：旧实现只剥 tier 不剥 deprecated 载荷，登记日恒误判 changed
    // （api-deprecate: 裁决类指引死码——re-tiered 桶的 deprecated 分支永不可达）
    const prev = { exports: [e('Old', 'berryagent', 'stable')], capabilities: [] };
    const curr = {
      exports: [
        e('Old', 'berryagent', 'deprecated', { deprecated: { dep: 'DEP-001', removalIn: '1.2', replacement: 'New' } }),
      ],
      capabilities: [],
    };
    const diff = classifyFaceDiff(prev, curr);
    expect(diff.changed).toEqual([]);
    expect(diff.reTiered).toEqual([{ key: 'berryagent::Old', from: 'stable', to: 'deprecated' }]);
  });
  it('DEP 撤销日（载荷消失 + tier 回升）与载荷-only 润色：前者 re-tiered、后者零桶', () => {
    const registered = {
      exports: [
        e('X', 'berryagent', 'deprecated', { deprecated: { dep: 'DEP-001', removalIn: '1.2', replacement: 'New' } }),
      ],
      capabilities: [],
    };
    // 撤销日：tier 回 stable、载荷消失 → re-tiered
    const unregistered = classifyFaceDiff(registered, { exports: [e('X')], capabilities: [] });
    expect(unregistered.changed).toEqual([]);
    expect(unregistered.reTiered).toEqual([{ key: 'berryagent::X', from: 'deprecated', to: 'stable' }]);
    // 载荷-only（replacement 文案润色）：tier 同 deprecated、载荷字段变 → 零桶
    const retouched = classifyFaceDiff(registered, {
      exports: [
        e('X', 'berryagent', 'deprecated', { deprecated: { dep: 'DEP-001', removalIn: '1.2', replacement: 'Better' } }),
      ],
      capabilities: [],
    });
    expect(retouched.changed).toEqual([]);
    expect(retouched.reTiered).toEqual([]);
    expect(retouched.added).toEqual([]);
    expect(retouched.removed).toEqual([]);
  });
  it('deprecated 符号真改形（载荷外字段变）仍归 changed——剥键不吞真变', () => {
    // module 属 key 构成（module::symbol）不构成「改形」——真改形用 since 字段变
    const dep = { dep: 'DEP-001', removalIn: '1.2', replacement: 'New' };
    const diff = classifyFaceDiff(
      {
        exports: [e('X', 'berryagent', 'deprecated', { since: '1.0', deprecated: dep })],
        capabilities: [],
      },
      {
        exports: [e('X', 'berryagent', 'deprecated', { since: '1.1', deprecated: dep })],
        capabilities: [],
      },
    );
    expect(diff.changed).toEqual(['berryagent::X']);
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
      '1.3',
    );
    expect(verdict.sanctioned).toEqual([{ key: 'berryagent::Due', dep: 'DEP-001' }]);
    expect(verdict.major).toEqual(['berryagent::NotDue', 'berryagent::Wild']);
  });
  it('版本比较逐段数值（1.10 > 1.9——字典序假阳在此红）', () => {
    // removalIn 1.9 对面号 1.10：数值序已到死期 = sanctioned；字典序会误判未到
    const verdict = judgeBreakages(
      ['berryagent::Due'],
      'removed',
      [{ dep: 'DEP-003', symbol: 'berryagent::Due', removalIn: '1.9' }],
      '1.10',
    );
    expect(verdict.sanctioned).toEqual([{ key: 'berryagent::Due', dep: 'DEP-003' }]);
    expect(verdict.major).toEqual([]);
  });
  it('号域纪律：判级基准 = 面号 apiVersion 两段形（§6.13.2 号独立演进）', () => {
    // 回归锁：旧签名收宿主 release 号再截断——宿主号漂移在面号前方时
    // （release 1.30.0 而面号仍 1.2）截断形 1.3 ≥ removalIn 1.3 会假判
    // 死期已到；判级必须对照面号本体：面号 1.2 < 1.3 = 窗口未走完 → MAJOR
    const verdict = judgeBreakages(
      ['berryagent::Due'],
      'removed',
      [{ dep: 'DEP-004', symbol: 'berryagent::Due', removalIn: '1.3' }],
      '1.2',
    );
    expect(verdict.major).toEqual(['berryagent::Due']);
    // 面号走到 1.3（= removalIn）即销账合法——边界含等
    const dueNow = judgeBreakages(
      ['berryagent::Due'],
      'removed',
      [{ dep: 'DEP-004', symbol: 'berryagent::Due', removalIn: '1.3' }],
      '1.3',
    );
    expect(dueNow.sanctioned).toEqual([{ key: 'berryagent::Due', dep: 'DEP-004' }]);
  });
});

describe('compareSemver / loadArchivedSnapshots：归档族排序（第九十一批——字典序两大陷阱锁）', () => {
  it('compareSemver：预发布 < 正式版、预发布段数值序（alpha.2 < alpha.10、rc 后于 alpha）', () => {
    // 陷阱一：'1.0.0' 是 '1.0.0-alpha.1' 前缀，字典序反排正式版在前；
    // 陷阱二：localeCompare 默认不开 numeric collation，'alpha.10' 字典序先于 'alpha.2'
    const order = ['1.0.0-alpha.2', '1.0.0-alpha.10', '1.0.0-rc.1', '1.0.0', '1.0.1'];
    expect([...order].reverse().sort(compareSemver)).toEqual(order);
  });
  it('compareSemver / loadArchivedSnapshots：非法 semver 形即炸（fail-loud——进化批 M9 删「非法沉底」兜底）', () => {
    // 修前形态：非法沉底排最新位（静默兜底）——垃圾归档文件被当作查 9 比较基准；
    // 归档目录是 release 机器契约 6 专属写入位，脏文件 = 机器损坏非容错输入，
    // 炸出来看而非排序吞掉（规范：契约篇 §6.13.6 fail-loud 条款）
    expect(() => compareSemver('oops.json', '1.0.0')).toThrow(/semver/);
    const dir = mkdtempSync(join(tmpdir(), 'berry-archived-snaps-'));
    try {
      writeFileSync(join(dir, 'oops.json'), JSON.stringify({ apiVersion: '1.0', exports: [], capabilities: [] }));
      expect(() => loadArchivedSnapshots(dir)).toThrow(/oops\.json/); // 报错点名脏文件
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('renderCompatibility：登记日端到端渲染（api-deprecate 裁决类文案复活锁）', () => {
  /** 迷你面工厂（两快照 + 注册簿 → 全文渲染断言） */
  const e = (symbol, tier = 'stable', extra = {}) => ({
    symbol,
    module: 'berryagent',
    tier,
    since: '1.0',
    formFactors: ['standalone'],
    ...extra,
  });
  it('登记日变更史小节呈现 re-tiered + api-deprecate 指引（不入 changed 无 DEP 假 MAJOR）', () => {
    const dep = {
      dep: 'DEP-001',
      symbol: 'berryagent::Old',
      introducedIn: '1.1',
      removalIn: '1.3',
      replacement: 'New',
    };
    const oldDep = { dep: 'DEP-001', removalIn: '1.3', replacement: 'New' };
    const text = renderCompatibility({
      surface: {
        apiVersion: '1.2',
        exports: [e('New'), e('Old', 'deprecated', { deprecated: oldDep })],
        capabilities: [],
      },
      deprecations: [dep],
      snapshots: [
        { version: '1.0.0', surface: { apiVersion: '1.0', exports: [e('Old')], capabilities: [] } },
        {
          version: '1.1.0',
          surface: { apiVersion: '1.1', exports: [e('Old', 'deprecated', { deprecated: oldDep })], capabilities: [] },
        },
        // 宿主号漂前面号前方：release 1.30.0 而面号仍 1.2——此版把 Old 删了
        // （死期 1.3 未到）：判级必须对照面号 → MAJOR；旧码传 release 号截断成
        // 1.3 ≥ 1.3 会假判销账 MINOR（号域回归锁——§6.13.2 号独立演进）
        {
          version: '1.30.0',
          surface: { apiVersion: '1.2', exports: [e('New')], capabilities: [] },
        },
      ],
    });
    // 登记日（1.1.0 小节）：旧实现误判 changed → 渲染「changed 无 DEP」假断
    expect(text).not.toContain('无 DEP（判 MAJOR）');
    expect(text).toContain('re-tiered');
    expect(text).toContain('api-deprecate:');
    expect(text).toContain('DEP 登记');
    // DEP 节死期状态用面号对照（面号 1.2 < removalIn 1.3 = 窗口内）
    expect(text).toContain('窗口内');
    // 1.30.0 小节：窗口未走完的删除断 MAJOR、不得进销账行
    expect(text).toContain('removed 无 DEP（判 MAJOR');
    expect(text).not.toContain('DEP-001 销账');
  });
});

describe('§6.13.4 点火可见性：enforcement 纪元章（全面复盘 20260903-91 刀五）', () => {
  /** 迷你导出条目（纪元渲染不涉面内容——形状凑齐即可） */
  const e = (symbol) => ({
    symbol,
    module: 'berryagent',
    tier: 'stable',
    since: '1.0',
    formFactors: ['standalone'],
  });
  it('eraOf 归一：键缺席/垃圾值 → pre-ignition（老快照零假翻转、误写不放大执法宣称）；显式 ignited 是唯一通路', () => {
    // 归一语义双闸：纪元章落地前的归档快照无键 = 窗口容忍态；非 'ignited' 值
    // 一律回落——纪元宣称只认显式点火（fail-closed 反向）
    expect(eraOf({})).toBe('pre-ignition');
    expect(eraOf({ enforcement: undefined })).toBe('pre-ignition');
    expect(eraOf({ enforcement: 'on-fire' })).toBe('pre-ignition');
    expect(eraOf({ enforcement: 'ignited' })).toBe('ignited');
  });
  it('提交位快照带 enforcement 纪元章且为合法两态（抽取器盖章在档——与点火常量同步由查 1 drift 执法）', () => {
    const surface = JSON.parse(readFileSync(join(ROOT, 'src/contracts/api-surface.json'), 'utf8'));
    expect(['pre-ignition', 'ignited']).toContain(surface.enforcement);
  });
  it('renderCompatibility 纪元三面：头部纪元行 + 归档族翻转行（零面变更也单列）+ 纪元一致预告节不噪声', () => {
    // 1.0.0 基线无 enforcement 键（纪元章前老快照形）→ 1.1.0 纯翻转零面变更；
    // 当前面快照 ignited 与最新归档一致 → 预告节零纪元项
    const text = renderCompatibility({
      surface: { apiVersion: '1.0', enforcement: 'ignited', exports: [e('A')], capabilities: [] },
      deprecations: [],
      snapshots: [
        { version: '1.0.0', surface: { apiVersion: '1.0', exports: [e('A')], capabilities: [] } },
        {
          version: '1.1.0',
          surface: { apiVersion: '1.0', enforcement: 'ignited', exports: [e('A')], capabilities: [] },
        },
      ],
    });
    expect(text).toContain('执法纪元：`ignited`');
    expect(text).toContain('执法纪元翻转');
    expect(text).toContain('`pre-ignition` → `ignited`');
    expect(text).toContain('api-break:');
    // 纯翻转 release 保留零面变更行——翻转与面变更是两件事，各自留痕不互吞
    expect(text).toContain('与上版快照一致（零面变更 release）');
    // 纪元一致（面快照 = 最新归档）→ 预告节不带纪元项
    expect(text).toContain('面快照与最新归档一致（零未发布面变更）');
  });
  it('点火日形态：当前面快照 ignited 而最新归档 pre-ignition → 未发布预告节点名纪元待翻转与 api-break: 裁决义务', () => {
    // 点火日 PR 的快照 diff 必落预告节——裁决义务（api-break:）由生成器点名，
    // 不靠 PR 作者自觉记忆规范条款
    const text = renderCompatibility({
      surface: { apiVersion: '1.0', enforcement: 'ignited', exports: [e('A')], capabilities: [] },
      deprecations: [],
      snapshots: [{ version: '1.0.0', surface: { apiVersion: '1.0', exports: [e('A')], capabilities: [] } }],
    });
    expect(text).toContain('执法纪元待翻转');
    expect(text).toContain('`pre-ignition` → `ignited`');
    expect(text).toContain('api-break:');
    expect(text).not.toContain('面快照与最新归档一致');
  });
});

describe('api-surface.json：formFactors 规范形锁（集合语义——书写序不渗入快照字节）', () => {
  it('提交位快照每条目 formFactors 升序（键表数组重排不构成面 diff 的机器面）', () => {
    // 抽取器落快照统一走排序拷贝——本锁读提交位快照：抽取器回归（再生成产乱序）
    // → 快照漂移被查 1 抓的同时本锁红，双保险
    const surface = JSON.parse(readFileSync(join(ROOT, 'src/contracts/api-surface.json'), 'utf8'));
    /** 乱序条目名清单（exports 与 capabilities 两半） */
    const offenders = [
      ...surface.exports
        .filter((x) => JSON.stringify(x.formFactors) !== JSON.stringify([...x.formFactors].sort()))
        .map((x) => x.symbol),
      ...surface.capabilities
        .filter((x) => JSON.stringify(x.formFactors) !== JSON.stringify([...x.formFactors].sort()))
        .map((x) => `cap:${x.name}`),
    ];
    expect(offenders).toEqual([]);
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
    // `* as ns` 是命名空间转发形不入 stars（20260904 #12 修法同步重锚——旧锚
    // ['.','./ns.js'] 锁定的正是目标被误收编的缺陷形状）
    expect(scan.stars).toEqual(['./star.js']);
  });

  it('自由符号标级载体：声明形直导出的紧前 JSDoc tier 入 tags（遗漏大扫 20260904 #4/#5——tier 载体分职兑现）', () => {
    const src = [
      '/** @experimental */',
      'export const zzTagged = 1;',
      'export const zzUntagged = 2;', // 无 JSDoc 块 → null（无标级载体）
      '/** 普通说明无 tier 词 */',
      'export function zzNoTier() {}', // 有块无标签 → null
      '/* 紧邻的非 JSDoc 注释——块归属以最后注释开器为准 */',
      'export const zzCut = 3;', // 紧前是 /* 形非 JSDoc → null
      'export { zzA } from "./other.js";', // 转译形（具名转发）不入 tags
    ].join('\n');
    const scan = scanTopLevelExports(src);
    expect(scan.tags.get('zzTagged')).toBe('experimental');
    expect(scan.tags.get('zzUntagged')).toBe(null);
    expect(scan.tags.get('zzNoTier')).toBe(null);
    expect(scan.tags.get('zzCut')).toBe(null);
    expect(scan.tags.has('zzA')).toBe(false);
  });

  it('【回归锁 进化批 M8】tier 标签词形须独立：连字符合成词不领级（@experimental-internal ≠ experimental）', () => {
    // 修前形态：\b 在 'l' 与 '-' 间成立——@experimental-internal 误领 experimental
    // 级（机器判据 = 标签词后不接 [\w-]，防连字符合成词；规范：契约篇 §6.13.3）
    const src = [
      '/** @experimental-internal 内部机制词 */',
      'export const zzHyphenTag = 1;',
      '/** @experimental 试用 */',
      'export const zzPlainTag = 2;',
      '/** @deprecated-alias 另一合成词 */',
      'export const zzDepHyphen = 3;',
    ].join('\n');
    const scan = scanTopLevelExports(src);
    expect(scan.tags.get('zzHyphenTag')).toBe(null); // 合成词不判 experimental
    expect(scan.tags.get('zzPlainTag')).toBe('experimental'); // 独立词形照收
    expect(scan.tags.get('zzDepHyphen')).toBe(null); // 同律 deprecated 侧
  });

  it('【回归锁 第十一轮 A5】export { x }（无 from）声明形直导出入 tags 执法面：紧前 JSDoc 标级收得、无标签记 null、有 from 转译形仍不入', () => {
    // 修前形态：OpenBrace 分支收名不收标签——花括无 from 形（头注形态分类
    // 「local」列）整族逃出 tags，自由符号静默落键级 stable、@experimental
    // 意图被丢弃，查 2 逐符号执法与 freeSymbolTier 双闸均漏
    const src = [
      "export * from './star.js';",
      '/** @experimental */',
      'export { zzBraced };', // 花括清单无 from + 紧前 JSDoc → tier 收得
      'const zzPlain = 1;',
      'export { zzPlain };', // 紧前是实码（const 声明的 JSDoc 不算 export 的紧前）→ null
      'export { zzFwd } from "./other.js";', // 有 from = 转译形不入 tags
    ].join('\n');
    const scan = scanTopLevelExports(src);
    expect(scan.tags.get('zzBraced')).toBe('experimental');
    expect(scan.tags.get('zzPlain')).toBe(null);
    expect(scan.names.get('zzBraced')).toEqual({ forwarded: false });
    expect(scan.tags.has('zzFwd')).toBe(false);
  });

  it('【回归锁 第十一轮 A6】JSDoc 体内含 /* 序列（glob 示例）不击穿开器定位：标级照常收得 + 普通注释截断与穿越候选两回归面保持', () => {
    // 修前形态：jsdocTierBefore 用无界 lastIndexOf('/*') 找开器——体内 glob 字样
    // （src/*.ts）成为「最后开器」，块起点错位 → 非双星形 → 标签静默丢失假红。
    // 修后从 close 端向前迭代词法合法候选：体内序列被跳过；紧随普通注释截断
    // 前置 JSDoc、更早 JSDoc 不被穿越误挂两既有行为同守
    const src = [
      '/**',
      ' * @experimental',
      ' * 扫描 src/*.ts 与 docs/* 下的文件。',
      ' */',
      'export const zzGlob = 1;',
      '/** @stable */',
      '/* 紧随的普通注释截断前置 JSDoc */',
      'export const zzCut = 2;',
      '/** @experimental */',
      'const zzHelper = 3;',
      '/* 归属说明 */',
      'export const zzNotMine = 4;',
    ].join('\n');
    const scan = scanTopLevelExports(src);
    expect(scan.tags.get('zzGlob')).toBe('experimental'); // 修前红：开器被体内 docs/* 击穿 → null
    expect(scan.tags.get('zzCut')).toBe(null); // 普通注释截断行为保持（非双星候选被跳过）
    expect(scan.tags.get('zzNotMine')).toBe(null); // 穿越候选被拒——不误挂 zzHelper 的 JSDoc
  });

  it('【回归锁 第十一轮 A7】export type { T } 前置 type 关键字花括清单形整条收得：有 from 转发记号正确 + 无 from 入 tags 执法面', () => {
    // 修前形态：type 前置形被 isDeclKeyword 分支吃掉——该分支 step 后只认
    // Identifier，`{` 直接蒸发，整条语句零记账（类型面静默缺席快照）；行内注释
    // 宣称「已被上方 OpenBrace 分支的顺序兜住」与实际行为相悖，同笔勘正
    const src = [
      "export type { ZzType } from './types.js';", // 前置 type 具名转发——修前整条漏收
      "export { type ZzInline, ZzValue } from './other.js';", // 对照：inline type 修饰正常收
      '/** @stable */',
      'export type { ZzLocal };', // 无 from 本地形——入 tags（紧前 JSDoc 收得）
      'type ZzOnly = string;', // 非导出不收
    ].join('\n');
    const scan = scanTopLevelExports(src);
    expect(scan.names.get('ZzType')).toEqual({ forwarded: false });
    expect(scan.names.get('ZzInline')).toEqual({ forwarded: false });
    expect(scan.names.get('ZzValue')).toEqual({ forwarded: false });
    expect(scan.names.get('ZzLocal')).toEqual({ forwarded: false });
    expect(scan.tags.get('ZzLocal')).toBe('stable');
    expect(scan.names.has('ZzOnly')).toBe(false);
  });

  it('命名空间转发形不进 stars：export * as ns 的目标模块不收编（遗漏大扫 20260904 #12——幻影面符号修死）', () => {
    // ns 本身已是面符号（运行时 barrel 仅 ns 一键可及）；目标进 stars 会被
    // 闭包递归展开成幻影面符号——目标私有导出被物化为顶层 API 面
    const scan = scanTopLevelExports("export * as ns from './internal.js';\n");
    expect([...scan.names.keys()]).toEqual(['ns']);
    expect(scan.stars).toEqual([]);
  });

  it('自由符号 tier 裁决纯函数：标签覆盖键级 / 缺标签 fail-loud / 非直导出维持键级（遗漏大扫 20260904 #4 腿1）', async () => {
    // 动态 import：修前无此导出（undefined 调用即红）——不静态 import 以免
    // 整测试文件在修前全红殃及他锁
    const { freeSymbolTier } = await import('./extract-api-surface.mjs');
    const key = { tier: 'stable' };
    const tags = new Map([
      ['zzTagged', 'experimental'],
      ['zzUntagged', null],
    ]);
    // 声明形直导出：标签覆盖键级 tier
    expect(freeSymbolTier(tags, { name: 'zzTagged', forwarded: false }, key)).toBe('experimental');
    // 内部星出收编形（非公开根直导出）：无标签可言，维持键级
    expect(freeSymbolTier(tags, { name: 'zzCollected', forwarded: false }, key)).toBe('stable');
    // 声明形直导出而标签缺席：fail-loud（闸面漏执法不允许静默降级）
    expect(() => freeSymbolTier(tags, { name: 'zzUntagged', forwarded: false }, key)).toThrow();
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

describe('api-doc-sections：实验面节豁免剥除（刀 E——节标记常量生成器与查 5 共享单源）', () => {
  it('三形：剥到下一 ## 节头 / 剥到文末 / 标题不在场原文返回', () => {
    // 中置形：豁免节后随同级节——剥到 `## b` 起点止（前段含节前空行原样保留）
    const mid = `# t\n\n## a\n\nx\n\n${EXPERIMENTAL_SECTION_HEADING}\n\n- exp\n\n## b\n\ny\n`;
    expect(stripExperimentalSection(mid)).toBe('# t\n\n## a\n\nx\n\n## b\n\ny\n');
    // 尾置形：豁免节在文末——剥到文末（残余空行不含符号、扫描期不修饰尾形）
    const tail = `# t\n\n${EXPERIMENTAL_SECTION_HEADING}\n\n- exp\n`;
    expect(stripExperimentalSection(tail)).toBe('# t\n\n');
    // 缺席形：零实验符号态（生成器未渲染本节）——原文返回
    const untouched = '# t\n\n## a\n\nx\n';
    expect(stripExperimentalSection(untouched)).toBe(untouched);
  });

  it('子节头不断节：### 属豁免区内部（行首锚定只认 ## 级标题）', () => {
    // 豁免节内的 ### 子节（将来实验键分组位）不终止剥除——其内符号仍在豁免区
    const nested = `# t\n\n${EXPERIMENTAL_SECTION_HEADING}\n\n### 分组\n\n- exp\n\n## b\n\ny\n`;
    expect(stripExperimentalSection(nested)).toBe('# t\n\n## b\n\ny\n');
  });
});

describe('api.ts 公开根分桶（刀 A——internal 机制桶七符号不进公开面，§6.13.4）', () => {
  it('INTERNAL_API_EXPORTS 逐名闭集：恰七名（白名单增删即红——单点漂移不静默）', async () => {
    // 动态 import：修前无此导出（undefined 解构调用即红）——不静态 import 以免
    // 整测试文件在修前全红殃及他锁
    const { INTERNAL_API_EXPORTS } = await import('./extract-api-surface.mjs');
    expect([...INTERNAL_API_EXPORTS].sort()).toEqual([
      'API_ENFORCEMENT_IGNITED',
      'SERVICE_CATALOG',
      'VIRTUAL_API_KEYS',
      'adjudicateApiGate',
      'assertExperimentalDeclared',
      'materializeHostFace',
      'requireCapabilities',
    ]);
  });

  it('assertApiBucketPartition 三向 fail-loud：未分类 / 漏桶 / 死名（注入白名单免牵连真册）', async () => {
    const { assertApiBucketPartition } = await import('./extract-api-surface.mjs');
    // 注入白名单：三违例形各自独立可红（不牵连库内真 api.ts/真白名单状态）
    const wl = new Set(['zzInternal']);
    // 合法通过形：全部落桶、无漏桶、无死名——不 throw
    expect(() => assertApiBucketPartition(['a', 'zzInternal'], ['a'], wl)).not.toThrow();
    // 未分类：api.ts 新顶层导出两桶皆不在——先分类再落码
    expect(() => assertApiBucketPartition(['a', 'zzNew'], ['a'], wl)).toThrow('未分桶：zzNew');
    // internal 漏桶：白名单符号出现在公开根面——机制符号不是应用 API
    expect(() => assertApiBucketPartition(['a', 'zzInternal'], ['a', 'zzInternal'], wl)).toThrow(
      '漏进公开桶：zzInternal',
    );
    // 白名单死名：api.ts 已无此名而白名单残留——改名/删除后烂尾即炸
    expect(() => assertApiBucketPartition(['a'], ['a'], wl)).toThrow('白名单死名：zzInternal');
  });

  it('快照分桶行为锁：七机制符号绝迹公开面、可见桶十四名在册（修前快照含七符号即红）', () => {
    // 星出时代机制符号实测进面（内部重构判伪 MAJOR 的面源）——本锁钉死分桶后
    // 的快照投影态：抽取器回归（七符号再进公开桶）→ 查 1 红的同时本锁红，双保险
    const surface = JSON.parse(readFileSync(join(ROOT, 'src/contracts/api-surface.json'), 'utf8'));
    const face = new Set(surface.exports.filter((e) => e.module === 'berryagent').map((e) => e.symbol));
    const internal = [
      'VIRTUAL_API_KEYS',
      'SERVICE_CATALOG',
      'API_ENFORCEMENT_IGNITED',
      'adjudicateApiGate',
      'assertExperimentalDeclared',
      'requireCapabilities',
      'materializeHostFace',
    ];
    expect(internal.filter((n) => face.has(n))).toEqual([]);
    const visible = [
      'ApiTier',
      'FormFactor',
      'VirtualApiKeyEntry',
      'ServiceCatalogEntry',
      'DescriptorKeyEntry',
      'CapabilityEntry',
      'ApiBlock',
      'ApiGateResult',
      'HostFace',
      'HostFaceData',
      'DATA_DESCRIPTOR_API_KEYS',
      'CAPABILITIES',
      'compareApiVersions',
      'isValidApiVersion',
    ];
    expect(visible.filter((n) => !face.has(n))).toEqual([]);
  });
});

describe('服务面方法级符号（刀 B——faceInterface 契约接口成员枚举，§6.13.4）', () => {
  // 动态 import 三件新机件：修前（刀 B 前）无此导出——undefined 解构调用即红，
  // 不静态 import 以免整测试文件在修前全红殃及他锁（刀 A 同款纪律）
  it('enumerateInterfaceMembers：方法/属性/get 上下文关键字/重载去重/索引签名豁免', async () => {
    const { enumerateInterfaceMembers } = await import('./extract-api-surface.mjs');
    // 复合夹具：一次覆盖六类成员形态（JSDoc 花括号/字符串引号名/readonly 属性/
    // 上下文关键字名 get·type/重载双签名/索引+调用+构造签名豁免）。入参形态 =
    // 接口体文本（`export interface X {` 与配对 `}` 之间——无外层花括）
    const members = enumerateInterfaceMembers(`
  /** 文档 { 花括号 } 与 \`\${模板} 都不是成员 */
  send(msg: string): Promise<void>;
  /** 重载相一 */
  uninstall(mode: 'inspect'): Promise<{ files: string[] }>;
  /** 重载相二（同名单签名组 = 同一 API 符号，去重） */
  uninstall(mode: 'execute'): Promise<number>;
  get(id: string): Job | undefined;
  type: 'cron' | 'once';
  readonly policyMode: string;
  'quoted-name'(x: number): void;
  [key: string]: unknown;
  (input: string): void;
  new (opts: { a: number }): Face;
`);
    expect(members).toEqual(['send', 'uninstall', 'get', 'type', 'policyMode', 'quoted-name']);
  });

  it('enumerateInterfaceMembers：深度失衡 fail-loud（多闭括即炸——静默截断不可接受）', async () => {
    const { enumerateInterfaceMembers } = await import('./extract-api-surface.mjs');
    // 体文本形态（无外层花括）：末尾孤立 `}}` 把深度推负——词法失步即炸
    expect(() => enumerateInterfaceMembers('a(x: { y: 1 }): void; }}')).toThrow();
  });

  it('findExportedInterfaces：泛型头 >> 合并 token / 嵌套 namespace 接口不收 / 模板串成员', async () => {
    const { findExportedInterfaces } = await import('./extract-api-surface.mjs');
    const map = findExportedInterfaces(`
export interface Outer<T extends Record<string, K>, U = Map<string, string[]>> {
  render(x: \`前缀\${T}\`): void;
}
namespace Inner {
  export interface Hidden { a(): void; }
}
export interface Plain { ok: true; }
`);
    // 只收深度 0 的 export 声明（Hidden 无 export 前导词在深度 0——不进索引）
    expect([...map.keys()].sort()).toEqual(['Outer', 'Plain']);
    expect(map.get('Outer')).toContain('render(x:');
    expect(map.get('Plain')).toContain('ok: true;');
  });

  it('buildInterfaceIndex 全仓：18 目录 faceInterface 各恰一源（零源/撞源均结构性即红）', async () => {
    const { buildInterfaceIndex } = await import('./extract-api-surface.mjs');
    // faceInterface 清单从 api.ts 源文正则取（新目录项自动进锁——不硬编码名单）
    const apiSrc = readFileSync(join(ROOT, 'src/contracts/api.ts'), 'utf8');
    const faces = [...apiSrc.matchAll(/faceInterface:\s*'(\w+)'/g)].map((m) => m[1]);
    expect(faces.length).toBeGreaterThanOrEqual(18); // 修前无 faceInterface 列 → 0 → 红
    const index = buildInterfaceIndex(join(ROOT, 'src'));
    for (const face of faces) {
      const hits = index.get(face) ?? [];
      expect(
        hits.length,
        `faceInterface ${face} 须恰一源（实得 ${hits.length}：${hits.map((h) => h.path).join(' ; ')}）`,
      ).toBe(1);
    }
  });

  it('SessionsServiceFace 真源 13 成员锁（新契约接口——成员增删即红）', async () => {
    const { findExportedInterfaces, enumerateInterfaceMembers } = await import('./extract-api-surface.mjs');
    const src = readFileSync(join(ROOT, 'src/session/service-face.ts'), 'utf8');
    const body = findExportedInterfaces(src).get('SessionsServiceFace');
    expect(body).toBeDefined();
    expect(enumerateInterfaceMembers(body)).toEqual([
      'createSession',
      'fork',
      'appendEvent',
      'currentSessionId',
      'adopt',
      'isBusy',
      'eventsOfType',
      'lastClosedBoundary',
      'logLength',
      'appendWithSurfaceOp',
      'deriveMessages',
      'projectedJsonChars',
      'queryEvents',
    ]);
  });

  it('快照行为锁：每服务 ≥1 方法符号 + 方法符号点名在册（修前快照 services 域仅服务名 18 条即红）', () => {
    const surface = JSON.parse(readFileSync(join(ROOT, 'src/contracts/api-surface.json'), 'utf8'));
    const services = surface.exports.filter((e) => e.module === 'services');
    // 18 服务各至少 2 条（服务名 1 + 方法 ≥1）——services 域缩回纯服务名形即红
    const bySvc = new Map();
    for (const e of services) {
      const svc = e.symbol.split('.')[0];
      bySvc.set(svc, (bySvc.get(svc) ?? 0) + 1);
    }
    expect([...bySvc.values()].every((n) => n >= 2)).toBe(true);
    expect(bySvc.size).toBeGreaterThanOrEqual(18);
    // 点名锚：跨六模块的方法符号样本（上下文关键字 get / 双相重载 uninstall / 13 面新件）
    const symbols = new Set(services.map((e) => e.symbol));
    for (const s of [
      'tools.register',
      'sessions.fork',
      'approval.policyMode',
      'jobs.get',
      'apps.uninstall',
      'ui.setWidget',
      'compaction.compactForOverflow',
    ]) {
      expect(symbols.has(s), `方法符号 ${s} 须在快照 services 域`).toBe(true);
    }
    // 方法符号形态律：`服务名.成员名` 两段（三段以上 = 枚举器产出嵌套名即红）
    expect(services.filter((e) => e.symbol.includes('.') && e.symbol.split('.').length !== 2)).toEqual([]);
  });

  it('grandfathering 行为锁：存量符号承袭提交快照 since、新符号落当前 apiVersion', async () => {
    const { extractSurface } = await import('./extract-api-surface.mjs');
    // extractSurface 读提交位快照作 prevSince 账本（幂等承袭）——对拍两账：
    // 已在提交快照的 services 符号 → since 逐条相等（恒承袭，CR3）；新符号 → pkg.apiVersion
    const committed = JSON.parse(readFileSync(join(ROOT, 'src/contracts/api-surface.json'), 'utf8'));
    const prev = new Map(committed.exports.filter((e) => e.module === 'services').map((e) => [e.symbol, e.since]));
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const extracted = (await extractSurface()).exports.filter((e) => e.module === 'services');
    // 快照重生成后幂等（108=108 全承袭）；快照滞后于代码时 extracted ≥ prev
    // （新方法符号落 pkg.apiVersion——本批首跑形态 18→108）
    expect(extracted.length).toBeGreaterThanOrEqual(prev.size);
    for (const e of extracted) {
      const expected = prev.get(e.symbol) ?? pkg.apiVersion;
      expect(e.since, `符号 ${e.symbol} since 承袭/新落账`).toBe(expected);
    }
  });
});

describe('签名指纹（刀 C——sig 稳定哈希 + classifyFaceDiff 双侧在场判差，§6.13.4）', () => {
  it('collectTopLevelDeclarations：顶层声明形态全景（体块/签名/重载拼接/再导出豁免）', async () => {
    const { collectTopLevelDeclarations } = await import('./extract-api-surface.mjs');
    // 覆盖 tsc 发射产物实测面：import 穿行 / 体块（interface/enum/namespace）闭
    // `}` 归零收 / 签名（type/const/function）深度 0 `;` 收 / 重载同名拼接 /
    // 再导出三形（export {…} from / export * from / export type {…} from——
    // index.d.ts barrel 恒含末形）无本文件声明块不收 / abstract 前导词忽略
    const dts = [
      "import { X } from './x.js';",
      'export interface Face { a : string ; }',
      'export declare type Alias = Face | null;',
      'export declare const obj : { readonly k : number };',
      'export declare function f ( a : string ) : void;',
      'export declare function f ( a : number ) : void;',
      'export declare enum En { A , B }',
      'export declare abstract class Cl { abstract m ( ) : void ; }',
      'export declare namespace Ns { export interface Hidden { } }',
      "export type { Face } from './y.js';",
      "export * from './z.js';",
      "export { X } from './x.js';",
    ].join('\n');
    const decls = collectTopLevelDeclarations(dts);
    // 再导出形不产声明；Hidden 是 namespace 体内嵌套声明非顶层（深度 ≥1 不收）
    expect([...decls.keys()]).toEqual(['Face', 'Alias', 'obj', 'f', 'En', 'Cl', 'Ns']);
    // 体块声明：闭 `}` 入规范文本（声明形状一半）；体内 `;` 在深度 1 不终结
    expect(decls.get('Face')).toBe('Face { a : string ; }');
    expect(decls.get('En')).toBe('En { A , B }');
    expect(decls.get('Ns')).toBe('Ns { export interface Hidden { } }');
    expect(decls.get('Cl')).toBe('Cl { abstract m ( ) : void ; }');
    // 签名声明：终结 `;` 不入规范文本；对象字面量型的闭 `}` 入（深度归零非终结位）
    expect(decls.get('Alias')).toBe('Alias = Face | null');
    expect(decls.get('obj')).toBe('obj : { readonly k : number }');
    // 重载同名：多块单空格拼接（任一签名变即指纹变）
    expect(decls.get('f')).toBe('f ( a : string ) : void f ( a : number ) : void');
  });

  it('collectTopLevelDeclarations：export default / export = 即红（命名导出纪律）', async () => {
    const { collectTopLevelDeclarations } = await import('./extract-api-surface.mjs');
    expect(() => collectTopLevelDeclarations('export default function f(): void;')).toThrow('export default');
    expect(() => collectTopLevelDeclarations('export = X;')).toThrow('export =');
  });

  it('sliceInterfaceMembers：规范文本形态（readonly 入指纹 / 重载拼接 / 终结符不入）', async () => {
    const { sliceInterfaceMembers } = await import('./extract-api-surface.mjs');
    const members = sliceInterfaceMembers(`
  send ( msg : string ) : Promise < void > ;
  readonly policyMode : string;
  uninstall ( mode : 'inspect' ) : Promise < number > ;
  uninstall ( mode : 'execute' ) : void;
  [ key : string ] : unknown;
  readonly [ index : number ] : string;
`);
    expect([...members.keys()]).toEqual(['send', 'policyMode', 'uninstall']);
    // 名 token 起至深度 0 终结符止（`;` 不入）；readonly 修饰符入（只读性是面承诺）
    expect(members.get('send')).toBe('send ( msg : string ) : Promise < void >');
    expect(members.get('policyMode')).toBe('readonly policyMode : string');
    // 重载同名录收 + 规范文本单空格拼接；字符串字面量 token 文本原样（引号保留）
    expect(members.get('uninstall')).toBe(
      "uninstall ( mode : 'inspect' ) : Promise < number > uninstall ( mode : 'execute' ) : void",
    );
    // 索引签名（含 readonly 前导形）无名不计——幻影防线
  });

  it('extractSurface sig 覆盖锁：五模块族形态 + 词表域缺席 + llm 互异 + 确定性', async () => {
    const mod = await import('./extract-api-surface.mjs');
    const { serializeSurface } = mod;
    const surface = await mod.extractSurface();
    /** 模块 → 该模块全条目（快照序） */
    const byMod = new Map();
    for (const e of surface.exports) {
      const list = byMod.get(e.module) ?? [];
      list.push(e);
      byMod.set(e.module, list);
    }
    const HEX16 = /^[0-9a-f]{16}$/;
    // 五模块族挂 sig：berryagent（转发形恒 'forwarded'、声明形 16hex）/ typebox
    // 三键恒 'forwarded'（上游承诺面）/ llm·sqlite（成员切片 16hex）/ services
    for (const e of byMod.get('berryagent')) {
      expect(e.sig, `berryagent ${e.symbol} sig`).toMatch(e.forwarded ? /^forwarded$/ : HEX16);
    }
    for (const key of ['typebox', 'typebox/value', 'typebox/compile']) {
      for (const e of byMod.get(key)) expect(e.sig, `${key} ${e.symbol}`).toBe('forwarded');
    }
    // 第五键四枚 sig 两两互异（同值 = 切片机把四键切重了）
    const llmSigs = byMod.get('berryagent/llm').map((e) => e.sig);
    expect(llmSigs.length).toBe(4);
    expect(new Set(llmSigs).size).toBe(llmSigs.length);
    for (const e of [...byMod.get('berryagent/llm'), ...byMod.get('berryagent/sqlite')]) {
      expect(e.sig, `${e.module} ${e.symbol}`).toMatch(HEX16);
    }
    // services 全挂（服务名 + 方法符号）；词表四域缺席（闭集词表无签名维度）
    for (const e of byMod.get('services')) expect(e.sig, `services ${e.symbol}`).toMatch(HEX16);
    for (const key of ['data-keys', 'live-events', 'manifest', 'session-events']) {
      for (const e of byMod.get(key)) expect('sig' in e, `${key} ${e.symbol} 不挂 sig`).toBe(false);
    }
    // 确定性：同进程二次抽取逐字节恒等（sig 哈希无时序/随机源）
    expect(serializeSurface(await mod.extractSurface())).toBe(serializeSurface(surface));
  });

  it('classifyFaceDiff：sig 双侧在场才判差（单向补挂 = 元数据迁移非签名变更）', async () => {
    const { classifyFaceDiff } = await import('./generate-compatibility.mjs');
    /** 迷你面条目（sig 语义测试面） */
    const e = (sig) => ({
      symbol: 'fork',
      module: 'services',
      tier: 'stable',
      since: '1.0',
      formFactors: ['standalone'],
      ...(sig === undefined ? {} : { sig }),
    });
    const face = (exports) => ({ exports, capabilities: [] });
    // 单侧补挂（旧快照无 sig / 新快照有）——不判差：迁移窗容忍（§6.13.4 判据迁移律）
    expect(classifyFaceDiff(face([e(undefined)]), face([e('aaaa1111aaaa1111')])).changed).toEqual([]);
    expect(classifyFaceDiff(face([e('aaaa1111aaaa1111')]), face([e(undefined)])).changed).toEqual([]);
    // 双侧在场且互异——changed 桶（签名级判据：同名改形）
    expect(classifyFaceDiff(face([e('aaaa1111aaaa1111')]), face([e('bbbb2222bbbb2222')])).changed).toEqual([
      'services::fork',
    ]);
    // 双侧同值——无差
    expect(classifyFaceDiff(face([e('aaaa1111aaaa1111')]), face([e('aaaa1111aaaa1111')])).changed).toEqual([]);
  });
});

describe('手稳件升生成物 + 扫描器 fail-loud（刀 D——§6.13.9 手稳件条款 + §6.13.4 键表对账）', () => {
  it('scanTopLevelExports：export default 直接炸（一名一符号——穿透修饰前缀修死）', async () => {
    const { scanTopLevelExports } = await import('./extract-api-surface.mjs');
    // 修前 default 被当普通修饰前缀穿透、默认名被记成顶层导出（幻影符号入口）
    expect(() => scanTopLevelExports('export default function f() {}')).toThrow('export default');
  });

  it('scanTopLevelExports：花括深度双向断言（下穿 0 即炸 / EOF 非 0 即炸）', async () => {
    const { scanTopLevelExports } = await import('./extract-api-surface.mjs');
    // 下穿 0：深度 0 处再遇闭 `}`（修前 Math.max 钳制静默咽下）
    expect(() => scanTopLevelExports('}')).toThrow('下穿 0');
    // EOF 非 0：失衡开括（修前静默收工，符号面在失步态上记账）
    expect(() => scanTopLevelExports('export const a = 1;\nconst y = {')).toThrow('EOF');
    // 绿侧对照：平衡形照常收名
    expect(scanTopLevelExports('export const a = 1;').names.has('a')).toBe(true);
  });

  it('findExportedInterfaces：角深度/头部花括下穿 0 即炸 + EOF 悬挂态即炸', async () => {
    const { findExportedInterfaces } = await import('./extract-api-surface.mjs');
    // 角深度下穿（修前钳制归零、后续 `{` 被误判体开器收错体）
    expect(() => findExportedInterfaces('export interface X> {}')).toThrow('角深度');
    // 头部花括下穿（修前钳制归零静默咽下）
    expect(() => findExportedInterfaces('export interface X }')).toThrow('头部花括');
    // EOF 悬挂：体收集中 / 头部态未收口（修前静默丢弃悬挂体返回空体映射）
    expect(() => findExportedInterfaces('export interface X {')).toThrow('EOF');
    expect(() => findExportedInterfaces('export interface X')).toThrow('EOF');
    // EOF 花括深度非 0（扫描态失衡）
    expect(() => findExportedInterfaces('const a = {')).toThrow('EOF');
    // 绿侧对照：正常接口照常收体（既有刀 B 用例为全量对照，此处最小绿锚）
    expect(findExportedInterfaces('export interface X { a: string }').get('X')).toBeTruthy();
  });

  it('assertVirtualKeyCoverage：键表有而面无即炸（键表-抽取接线漂移抽取期红）', async () => {
    const { assertVirtualKeyCoverage } = await import('./extract-api-surface.mjs');
    const keys = [{ key: 'berryagent' }, { key: 'berryagent/llm' }, { key: 'berryagent/sqlite' }];
    // 缺 berryagent/llm：整键域从快照蒸发的窗口关死在抽取期
    expect(() => assertVirtualKeyCoverage(keys, [{ module: 'berryagent' }, { module: 'berryagent/sqlite' }])).toThrow(
      'berryagent/llm',
    );
    // 全覆盖：静默过
    expect(() =>
      assertVirtualKeyCoverage(keys, [
        { module: 'berryagent' },
        { module: 'berryagent/llm' },
        { module: 'berryagent/sqlite' },
      ]),
    ).not.toThrow();
  });

  it('renderFaceDecls：从面快照渲染两 Face 派生 .d.ts（定格形态 + 空域即炸）', async () => {
    const { renderFaceDecls, declareKeysOf } = await import('./generate-api-decls.mjs');
    const surface = {
      exports: [
        {
          symbol: 'createProvider',
          module: 'berryagent/llm',
          tier: 'stable',
          since: '1.0',
          formFactors: ['standalone'],
        },
        {
          symbol: 'anthropicMessagesApi',
          module: 'berryagent/llm',
          tier: 'stable',
          since: '1.0',
          formFactors: ['standalone'],
        },
        {
          symbol: 'openDatabase',
          module: 'berryagent/sqlite',
          tier: 'stable',
          since: '1.0',
          formFactors: ['standalone'],
        },
      ],
    };
    const rendered = renderFaceDecls(surface);
    // llm 件：alias 行在场 + declare 行按快照序（键集派生非手写序）
    const llm = rendered.get('berryagent-llm.d.ts');
    expect(llm).toContain("import type { providerApiFace } from '../llm/provider-face.js';");
    expect(llm).toContain('type Face = typeof providerApiFace;');
    expect(llm).toContain("export declare const createProvider: Face['createProvider'];");
    // 定格形态：恰一尾换行（生成物纪律）
    expect(llm.endsWith('\n') && !llm.endsWith('\n\n')).toBe(true);
    // sqlite 件：无 alias、直引 AppSqliteFace
    const sqlite = rendered.get('berryagent-sqlite.d.ts');
    expect(sqlite).toContain("import type { AppSqliteFace } from '../persist/app-sqlite.js';");
    expect(sqlite).toContain("export declare const openDatabase: AppSqliteFace['openDatabase'];");
    expect(sqlite).not.toContain('type Face');
    // declareKeysOf：逐行识别、非 declare 行不收
    expect(declareKeysOf(llm)).toEqual(['createProvider', 'anthropicMessagesApi']);
    // 空域即炸：快照模块域缺席 = 派生源漂移，fail-loud
    expect(() => renderFaceDecls({ exports: [surface.exports[0]] })).toThrow('berryagent/sqlite');
  });

  it('手稳件升生成物：committed 两 .d.ts = renderFaceDecls(提交位快照)（查 8 drift 面收录锁）', async () => {
    const { renderFaceDecls, FACE_DECL_SPECS } = await import('./generate-api-decls.mjs');
    const surface = JSON.parse(readFileSync(join(ROOT, 'src/contracts/api-surface.json'), 'utf8'));
    const rendered = renderFaceDecls(surface);
    // 修前两件为手稳件（手写 declare 序 + 无生成器头注）——本断言修复前必红
    for (const spec of FACE_DECL_SPECS) {
      expect(readFileSync(join(ROOT, 'api-decls', spec.fileName), 'utf8')).toBe(rendered.get(spec.fileName));
    }
  });
});

describe('API 参考进化（刀 L——desc harvest + 声明种类分组 + doc-only 载荷分类豁免，§6.13.9）', () => {
  it('firstPublicSentence：知识域滤词五形 + 句号剥离 + CJK 行接假空格归一', () => {
    // ① 括注组剥除：命中知识域 RE 的括组整组剥、普通括组保留
    expect(firstPublicSentence('服务面注册器（契约篇 §1.5 服务行）。')).toBe('服务面注册器');
    expect(firstPublicSentence('服务面注册器（两層模型）。')).toBe('服务面注册器（两層模型）');
    // ② 破折号尾注：尾段命中知识域即截断在最早 —— 处；未命中保持原文
    expect(firstPublicSentence('语义主体——详见契约篇 §2.2。')).toBe('语义主体');
    expect(firstPublicSentence('语义主体——补充说明。')).toBe('语义主体——补充说明');
    // ③ 首句即指路句 → 退取次句（机器兜底——不产红也不放行脏句）
    expect(firstPublicSentence('契约篇 §2.2 载明。实际语义在此。')).toBe('实际语义在此');
    // ④ 全滤灭 → undefined（调用方省略 desc 字段）
    expect(firstPublicSentence('详见运行时骨架篇。')).toBeUndefined();
    expect(firstPublicSentence('')).toBeUndefined();
    // ⑤ 句号剥离：切句剥界定符——desc 不带句号（快照不带标点，渲染层统一补）
    expect(firstPublicSentence('首句语义。次句。')).toBe('首句语义');
    // ⑥ CJK 行接假空格归一：JSDoc 行折 join(' ') 在汉字间产的伪空格剥除
    expect(firstPublicSentence('语义主体\n 继续保持。')).toBe('语义主体继续保持');
    // ⑦ 缩写词（刀 L 实证漏网形——32 处「骨架篇」经单源 RE 扩展收编）
    expect(firstPublicSentence('语义（骨架篇 §1.3）。')).toBe('语义');
  });

  it('descFromJsdoc：null 直通 undefined / @ 标签行丢弃 / 多行行首星剥除', () => {
    // 无紧前 JSDoc 块是常态位（声明可裸）——null 直通，不炸
    expect(descFromJsdoc(null)).toBeUndefined();
    // @ 标签行是 tier 载体不是语义——整行丢弃后取首句
    expect(descFromJsdoc(['/**', ' * 首句语义载体。', ' * @experimental', ' */'].join('\n'))).toBe('首句语义载体');
    // 多行正文行首星剥除后单空格联接——联接空格落 CJK 两侧即行折伪影，归一剥除
    expect(descFromJsdoc(['/**', ' * 白名单', ' * 单源载体。', ' */'].join('\n'))).toBe('白名单单源载体');
    // 块无正文（纯标签块）→ undefined
    expect(descFromJsdoc('/** @experimental */')).toBeUndefined();
  });

  it('scanTopLevelExports docs/kinds/namedSpecs：声明形直导 JSDoc 全收 / 裸声明 null / 具名转发相对说明符入 namedSpecs', () => {
    const src = [
      '/** 服务面注册器：两層模型。 */',
      'export const alphaSvc = 1;',
      'export interface Delta {}',
      'export function beta() {}',
      'export const bare = 2;', // 裸声明 → docs 记 null（有声明无文档的常态位）
      "export { named } from './other.js';", // 具名转发·相对说明符 → namedSpecs（刀 L docs-only 递归地基）
      "export { pkgThing } from 'typebox';", // 具名转发·包说明符 → 不入（forwarded 域）
      "export * from './star.js';", // 星出 → stars 不入 namedSpecs
    ].join('\n');
    const scan = scanTopLevelExports(src);
    expect(scan.docs.get('alphaSvc')).toBe('/** 服务面注册器：两層模型。 */');
    expect(scan.docs.get('bare')).toBe(null);
    expect(scan.kinds.get('alphaSvc')).toBe('const');
    expect(scan.kinds.get('Delta')).toBe('interface');
    expect(scan.kinds.get('beta')).toBe('function');
    expect(scan.kinds.has('named')).toBe(false); // 转发形不产本地 kind（声明块在目标文件）
    expect(scan.namedSpecs).toEqual(['./other.js']);
  });

  it('sliceInterfaceMembersDetailed：成员 doc 归属（名 token 起点收割）+ 薄投影 canonical 等值 + 重载 doc 首现保留', () => {
    const body = [
      '  /** 成员语义甲：白名单单源。 */',
      '  readonly a: string;',
      '  plain: number;',
      '  /** 成员语义乙（契约篇 §1.5）。 */',
      '  later(x: number): void;',
      '  later(): void;', // 重载第二相：无紧前 JSDoc——doc 首现保留（组首是 JSDoc 惯例位）
    ].join('\n');
    const detailed = [...sliceInterfaceMembersDetailed(body)];
    const byName = new Map(detailed);
    expect(byName.get('a').doc).toBe('/** 成员语义甲：白名单单源。 */');
    expect(byName.get('plain').doc).toBe(null); // 无紧前块 → null（desc 省略形）
    expect(byName.get('later').doc).toBe('/** 成员语义乙（契约篇 §1.5）。 */');
    expect(byName.get('later').canonical).toBe('later ( x : number ) : void later ( ) : void');
    // 薄投影等值：sliceInterfaceMembers 是详细形态的 canonical 投影（既有消费面稳定签名）
    expect([...sliceInterfaceMembers(body)]).toEqual(detailed.map(([name, v]) => [name, v.canonical]));
  });

  it('【回归锁 API 进化刀 L】classifyFaceDiff 剥 desc/kind 载荷：desc 改写与 kind 新增零桶（doc-only 载荷不入判差）', () => {
    // 修前形态：classifyFaceDiff 只剥 tier/deprecated/sig——desc/kind 新载荷渗入
    // rest 深比较 → 纯文档进化（本刀 459 符号全量重写 desc）被判 changed 假红
    const e = (symbol, extra = {}) => ({
      symbol,
      module: 'berryagent',
      tier: 'stable',
      since: '1.0',
      formFactors: ['standalone'],
      ...extra,
    });
    const prev = { exports: [e('Keep', { desc: '旧语义', kind: 'const' })], capabilities: [] };
    const curr = {
      exports: [e('Keep', { desc: '新写的一句话语义（文档进化）', kind: 'function' })],
      capabilities: [],
    };
    const diff = classifyFaceDiff(prev, curr);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]); // 修前红：desc/kind 差异被判 changed
    expect(diff.reTiered).toEqual([]);
    // 对照组：since 变仍判 changed——判差面（承诺字段）不被过度剥除
    const diff2 = classifyFaceDiff(prev, {
      exports: [e('Keep', { desc: '新写的一句话语义（文档进化）', kind: 'function', since: '1.1' })],
      capabilities: [],
    });
    expect(diff2.changed).toEqual(['berryagent::Keep']);
  });

  it('renderApiReference：desc 行渲染（句号统一补）+ 声明种类分组子头 + 无 kind 域平铺不分组', () => {
    const surface = {
      apiVersion: '1.0.0-alpha.4',
      capabilities: [],
      exports: [
        // 分组域：berryagent 携带 kind——常量/类型/函数三组 + 组内字典序
        {
          symbol: 'zFn',
          module: 'berryagent',
          tier: 'stable',
          since: '1.0',
          formFactors: ['standalone'],
          kind: 'function',
          desc: '函数语义',
        },
        {
          symbol: 'aConst',
          module: 'berryagent',
          tier: 'stable',
          since: '1.0',
          formFactors: ['standalone'],
          kind: 'const',
          desc: '常量语义载体句',
        },
        {
          symbol: 'bType',
          module: 'berryagent',
          tier: 'stable',
          since: '1.0',
          formFactors: ['standalone'],
          kind: 'interface',
        },
        // 平铺域：无 kind（词表域/服务域形态）——不分组不产子头
        {
          symbol: 'kvEntry',
          module: 'data-keys',
          tier: 'stable',
          since: '1.0',
          formFactors: ['standalone'],
          desc: '词表语义。',
        },
      ],
    };
    const md = renderApiReference({ surface, deprecations: [] });
    // desc 不带句号（快照标点纪律）→ 渲染层统一补
    expect(md).toContain('- `zFn` — 函数语义。stable（minor 只增不破），since 1.0，standalone');
    // desc 已带句号 → 不双补
    expect(md).toContain('- `kvEntry` — 词表语义。stable（minor 只增不破）');
    // 无 desc → 退旧形（承诺注记直衔）
    expect(md).toContain('- `bType` — stable（minor 只增不破），since 1.0，standalone');
    // 分组子头在场（组序固定：常量→类型→函数）；平铺域不产子头。
    // 节界取行首锚定 /^## /m——朴素 indexOf('## ') 会先命中 '### ' 子头自身
    const sectionOf = (md, header) => {
      const start = md.indexOf(header);
      const next = md.slice(start + 1).search(/^## /m);
      return next === -1 ? md.slice(start) : md.slice(start, start + 1 + next);
    };
    const berrySection = sectionOf(md, '## `berryagent`');
    expect(berrySection.indexOf('### 常量')).toBeLessThan(berrySection.indexOf('### 类型'));
    expect(berrySection.indexOf('### 类型')).toBeLessThan(berrySection.indexOf('### 函数'));
    expect(sectionOf(md, '## `data-keys`')).not.toContain('### ');
  });

  it('提交位快照 desc/kind 卫生：berryagent 非转发全带 desc+kind（kind 闭集）+ 全域 desc 零命中知识域 RE', () => {
    const surface = JSON.parse(readFileSync(join(ROOT, 'src/contracts/api-surface.json'), 'utf8'));
    const berryNonFwd = surface.exports.filter((e) => e.module === 'berryagent' && e.forwarded !== true);
    // 修前红两腿：① 具名再导出目标（api.ts 家族 14 符号）不入闭包 → kind 缺席
    // （刀 L namedSpecs docs-only 递归修死）；② 花括无 from 形（export type { T }）
    // null docs 击穿声明位块 → TextContent/ImageContent desc 被斩（null 不覆写修死）
    for (const e of berryNonFwd) {
      expect(e.desc, `berryagent::${e.symbol} desc 缺席`).toBeDefined();
      expect(e.kind, `berryagent::${e.symbol} kind 缺席`).toBeDefined();
    }
    // kind 闭集：声明块关键字五形（typebox 转发域不带 kind——上游包产物）
    expect(
      [...new Set(berryNonFwd.map((e) => e.kind))].every((k) =>
        ['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum'].includes(k),
      ),
    ).toBe(true);
    // 花括再导出斩击回归锚：llm 声明位 desc 在场（修前被 null 击穿）
    const textContent = surface.exports.find((e) => e.symbol === 'TextContent');
    expect(textContent.desc).toContain('文本块');
    // 全域 desc 公开卫生：任何 desc 不得命中知识域 RE（滤词出口的提交位实锚）
    const dirty = surface.exports.filter((e) => e.desc !== undefined && KNOWLEDGE_DOMAIN_RE.test(e.desc));
    expect(dirty.map((e) => `${e.module}::${e.symbol}`)).toEqual([]);
  });
});
