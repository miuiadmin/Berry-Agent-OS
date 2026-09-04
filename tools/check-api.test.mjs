/**
 * check-api 机器闸回归锁（API 治理 §6.13.8，第八十七批批 2 起——查 8 探针与
 * 生成器单测随第九十一批）——check-topology.test.mjs / check-events.test.mjs
 * 同款收编（vitest 窄面 spawn 真脚本 + 纯函数单测，tsc 视门外纯 node 语义直跑）。
 *
 * 层锁：
 * 1. 净树 spawn：九查全绿 exit 0（门禁链占位在岗——脚本被删/依赖断链先在此红）；
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
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanTopLevelExports } from './extract-api-surface.mjs';
import { EXPERIMENTAL_SECTION_HEADING, stripExperimentalSection } from './api-doc-sections.mjs';
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

describe('check-api 机器闸：净树全绿（九查集成锁）', () => {
  it('spawn 真脚本 exit 0——快照与抽取真值同步 + 生成物与渲染真值同步 + 九查零问题', () => {
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

describe('check-api 扫描侧可红探针（CHECK_API_ROOT / CHECK_API_SURFACE 双缝——就绪度审计 20260903 P1）', () => {
  /**
   * 夹具树基线（CHECK_API_ROOT 的消费前提）：查 2 barrel 读 / 查 7 apps 目录与
   * package.json 读是无条件面——夹具根缺任一即脚本 crash 先于出口（problems
   * 永不落 stderr，断言必空）。基线三件全绿形：纯星出 barrel（scanTopLevelExports
   * 只收直导出——星出走 stars 不进 names）/ 带 api 块合法清单 / apiVersion 1.0。
   * 每探针在基线上只注入一处违规——红归因唯一（守护炮负例探针纪律）。
   * 脚本侧真值（jiti 载真契约面 / 生成器真值 / 真注册簿）恒走真仓不随缝移——
   * 注入侧只动扫描树与面清单（check-api.mjs 顶注缝契约）。
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

  /** spawn 门禁（env 缝注入 + 仓库 cwd——与门禁链同一调用形态） */
  const runGate = (extraEnv) =>
    spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    });

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
  it('compareSemver：非法形态沉底排最末（防御兜底不隐形夹进远古史）', () => {
    // 回归锁：旧实现非法形返回 [-1,-1,-1] 排最前——与「沉底」注释相反，坏文件名
    // 被夹进基线侧隐形；沉底 = 排最新位（变更史尾节人眼常扫处可见）
    const order = ['1.0.0', '1.1.0', 'oops.json'];
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
