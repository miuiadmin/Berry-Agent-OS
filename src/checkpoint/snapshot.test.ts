/**
 * L3 checkpoint 单元测试（snapshot.ts 捕获引擎 + 裁剪规划半边）——
 * stat 快径引用既有 blob / 内容变更新 / 8MiB 超限跳过 / 剪枝表与 exclude
 * 尊重 / prunePlan 纯函数四场景（每会话帽、全局软帽、在册下界保护、不可达
 * 无下界、共享 blob 去重计字节）/ executePrune 删 manifest + 清孤 blob。
 * hermetic：临时目录作工作区与数据根，用后即清。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSnapshot, executePrune, prunePlan, type PruneOptions } from './snapshot.js';
import { canonicalize, serializeWrites } from '../tools/fs.js';
import { DEFAULT_EXCLUDE } from './app.js';
import {
  hashContent,
  listAllManifests,
  listSessionManifests,
  manifestPath,
  readBlob,
  type CheckpointManifest,
} from './store.js';

/** 临时根（工作区 + 数据根各一子目录；结束后整体清除） */
let root: string;
let workspace: string;
let dataRoot: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'checkpoint-snap-test-'));
  workspace = join(root, 'ws');
  dataRoot = join(root, 'store');
  mkdirSync(workspace, { recursive: true });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 写工作区文件（相对路径建父目录） */
function put(rel: string, content: string): void {
  const abs = join(workspace, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** 捕获调用捷径（exclude 缺省两剪枝名——与件本体缺省一致） */
function capture(sessionId: string, triggerTool = 'write') {
  return captureSnapshot(
    { dataRoot, workspaceRoot: workspace, exclude: ['node_modules/', '.git/'] },
    { sessionId, triggerTool, guard: false, forkSeq: null, triggerText: null },
  );
}

/** 微睡（2ms——连拍间拉开 time 毫秒差，manifest 降序主键确定性） */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

describe('captureSnapshot：首拍与指纹', () => {
  it('首拍：文件入 manifest、blob 落盘可回读、hash 正确、newBytes = 实际落盘字节', async () => {
    put('a.txt', '内容甲');
    put('sub/b.txt', '内容乙');
    const m = await capture('sess-first');
    expect(m.files.map((f) => f.rel)).toEqual(['a.txt', 'sub/b.txt']); // 字典序确定
    const hashA = hashContent(Buffer.from('内容甲', 'utf8'));
    expect(m.files[0]!.hash).toBe(hashA);
    // blob 可回读且内容一致（恢复路根基）
    expect((await readBlob(dataRoot, hashA)).toString('utf8')).toBe('内容甲');
    // 新写计数 = 两文件字节数和；总字节同
    const expected = Buffer.byteLength('内容甲', 'utf8') + Buffer.byteLength('内容乙', 'utf8');
    expect(m.newBytes).toBe(expected);
    expect(m.totalBytes).toBe(expected);
    expect(m.skipped).toEqual([]);
  });

  it('二拍未变：stat 快径引用既有 hash（newBytes = 0，零新增）', async () => {
    await tick();
    const m = await capture('sess-first');
    const first = (await listSessionManifests(dataRoot, 'sess-first'))[1]!;
    // 每路径 hash 与首拍一致（引用既有 blob）
    expect(m.files.map((f) => f.hash)).toEqual(first.files.map((f) => f.hash));
    expect(m.newBytes).toBe(0); // 未变零新写——存储成本审计的正确性根基
  });

  it('内容变：变更文件换 hash 计新写；未变文件仍引用既有', async () => {
    put('a.txt', '内容甲-改长版'); // 尺寸变（避开同尺寸同 mtime 盲区——诚实边界②）
    await tick();
    const m = await capture('sess-first');
    const hashNew = hashContent(Buffer.from('内容甲-改长版', 'utf8'));
    const entryA = m.files.find((f) => f.rel === 'a.txt')!;
    expect(entryA.hash).toBe(hashNew);
    // sub/b.txt 未变：引用既有（快径）
    const first = (await listSessionManifests(dataRoot, 'sess-first'))[0]!;
    const entryB = m.files.find((f) => f.rel === 'sub/b.txt')!;
    expect(entryB.hash).toBe(first.files.find((f) => f.rel === 'sub/b.txt')!.hash);
    // newBytes 只计变更文件（既有 blob 命中零新增）
    expect(m.newBytes).toBe(Buffer.byteLength('内容甲-改长版', 'utf8'));
  });

  it('单文件超 8MiB：进 skipped 披露面、不入 files、不读内容', async () => {
    put('big.bin', ''); // 先占位——下面写真实超限体量
    writeFileSync(join(workspace, 'big.bin'), Buffer.alloc(8 * 1024 * 1024 + 1, 7));
    put('small.txt', '小文件');
    await tick();
    const m = await capture('sess-first');
    expect(m.skipped).toContain('big.bin');
    expect(m.files.some((f) => f.rel === 'big.bin')).toBe(false);
    expect(m.files.some((f) => f.rel === 'small.txt')).toBe(true);
    // totalBytes 不含超限文件
    expect(m.totalBytes).toBe(m.files.filter((f) => f.rel !== 'big.bin').reduce((sum, f) => sum + f.size, 0));
  });

  it('剪枝表与 exclude：node_modules / .git / exclude 规则 / .gitignore 全不入快照', async () => {
    put('node_modules/pkg/index.js', '装机物');
    put('.git/objects/ab', 'git 对象');
    put('dist/out.js', '显式排除');
    put('ignored.log', '被 gitignore');
    put('.gitignore', 'ignored.log\n');
    await tick();
    // 本用例自持 exclude（叠加 dist/ 显式规则——验证配置面生效，非硬表）
    const m = await captureSnapshot(
      { dataRoot, workspaceRoot: workspace, exclude: ['node_modules/', '.git/', 'dist/'] },
      { sessionId: 'sess-first', triggerTool: 'write', guard: false, forkSeq: null, triggerText: null },
    );
    const rels = m.files.map((f) => f.rel);
    expect(rels).not.toContain('node_modules/pkg/index.js'); // PRUNE_DIRS 硬表
    expect(rels).not.toContain('.git/objects/ab'); // PRUNE_DIRS 硬表
    expect(rels).not.toContain('dist/out.js'); // exclude 配置规则
    expect(rels).not.toContain('ignored.log'); // 祖先链 .gitignore（根目录规则）
    expect(rels).toContain('.gitignore'); // .gitignore 本身是普通文件（照拍）
  });
});

describe('captureSnapshot：捕获读入写串行链（遗漏大扫 20260902-b #4）', () => {
  it('兄弟写段进行中捕获——内容读排队到写段收尾，撕裂中间态不入 blob 仓', async () => {
    // 修前形态：捕获的 readFile 在链外裸跑，读到 truncate-then-write 半途的
    // 撕裂字节 → hashContent+writeBlob 把「从未作为已提交状态存在过的半截
    // 内容」永固进 blob 仓（/rewind 恢复出半截文件——读侧 sha256 校验只验
    // blob 自身完整，撕裂 hash 与撕裂内容自洽必通过，防不住源面撕裂）。
    put('chain/target.txt', 'old-完整前态');
    await capture('sess-chain'); // 基线 manifest（target.txt = hash(old)）

    // 假兄弟写者：真 serializeWrites 段内先落撕裂半截、持链 150ms、再写完终态
    // ——与工具 write 同一模块级链（多会话共享一块物理文件系统的互斥根基）。
    const abs = join(workspace, 'chain/target.txt');
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 150)); // 撕裂窗持链
    const writer = serializeWrites([await canonicalize(abs)], async () => {
      writeFileSync(abs, 'torn-半截', 'utf8'); // truncate-then-write 的中间态落盘
      await gate; // 大文件写的几十 ms 窗（测试放大到 150ms 保确定性）
      writeFileSync(abs, 'final-完整终态', 'utf8');
    });
    await tick(); // 让写段进入（撕裂态已落盘、链已持有）

    const capturing = capture('sess-chain'); // 兄弟写进行中触发捕获
    await writer; // 写段收尾（撕裂窗关闭）
    const m = await capturing;

    // 关键回归锁：捕获到的必须是写段收尾后的完整终态——非撕裂中间态
    const entry = m.files.find((f) => f.rel === 'chain/target.txt')!;
    expect(entry.hash).toBe(hashContent(Buffer.from('final-完整终态', 'utf8')));
    expect((await readBlob(dataRoot, entry.hash)).toString('utf8')).toBe('final-完整终态');
    // 撕裂中间态绝不入 blob 仓（永固面为零）
    expect(entry.hash).not.toBe(hashContent(Buffer.from('torn-半截', 'utf8')));
  });

  it('无写者在链：捕获照常完成（链开销不改变无争用路径语义）', async () => {
    put('chain/quiet.txt', '静默文件');
    await tick();
    const m = await capture('sess-chain');
    const entry = m.files.find((f) => f.rel === 'chain/quiet.txt')!;
    expect((await readBlob(dataRoot, entry.hash)).toString('utf8')).toBe('静默文件');
  });
});

describe('captureSnapshot：秘密文件缺省排除（基建大扫 #39）', () => {
  // 独立工作区/数据根：本段断言要 manifest 文件集恰好等于当场放置集，
  // 不与首 describe 共享 workspace（那里残留 a.txt/sub 等历史文件会污染全集断言）
  let ws: string;
  let store: string;
  beforeAll(() => {
    ws = join(root, 'ws-secret');
    store = join(root, 'store-secret');
    mkdirSync(ws, { recursive: true });
  });
  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  /** 独立工作区写文件捷径（本段用例全在根层，无子目录） */
  const putSecret = (rel: string, content: string): void => writeFileSync(join(ws, rel), content, 'utf8');

  /** 独立捕获捷径（exclude 显式给——缺省面由件本体 DEFAULT_EXCLUDE 持有，此处消费它） */
  const snapSecret = (exclude: readonly string[], sessionId: string) =>
    captureSnapshot(
      { dataRoot: store, workspaceRoot: ws, exclude },
      { sessionId, triggerTool: 'write', guard: false, forkSeq: null, triggerText: null },
    );

  it('DEFAULT_EXCLUDE 常量在件本体：目录剪枝 + 秘密清单（修前模块缺席即红）', () => {
    expect(DEFAULT_EXCLUDE).toContain('node_modules/'); // 目录剪枝（原硬编码缺省保留）
    expect(DEFAULT_EXCLUDE).toContain('.env'); // 环境变量文件
    expect(DEFAULT_EXCLUDE).toContain('.env.*'); // .env.local 等变体
    expect(DEFAULT_EXCLUDE).toContain('*.pem'); // 证书/私钥
    expect(DEFAULT_EXCLUDE).toContain('*.key'); // 密钥
    expect(DEFAULT_EXCLUDE).toContain('id_rsa*'); // SSH 私钥族
  });

  it('秘密文件不入快照、普通文件照入：工作区秘密永不进 blob 仓与 manifest', async () => {
    putSecret('.env', 'API_TOKEN=sk-live-9f2c');
    putSecret('.env.local', 'API_TOKEN=sk-live-9f2c');
    putSecret('id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----');
    putSecret('cert.pem', '-----BEGIN CERTIFICATE-----');
    putSecret('a.txt', '正常文件');
    const m = await snapSecret(DEFAULT_EXCLUDE, 'sess-secret');
    expect(m.files.map((f) => f.rel)).toEqual(['a.txt']); // 恰好只剩普通文件（独立工作区无残留）
  });

  it('否定 glob 显式放开：exclude 追加 !.env 后 .env 入快照（operator 主动声明面）', async () => {
    // ignore 库 gitignore 语义：后规则覆盖前规则——!.env 只重开字面 .env，
    // 未点名的秘密与变体仍排除（精确放开，非全量放开）
    const m = await snapSecret([...DEFAULT_EXCLUDE, '!.env'], 'sess-secret-allow');
    const rels = m.files.map((f) => f.rel);
    expect(rels).toContain('.env'); // 显式放开生效
    expect(rels).toContain('a.txt'); // 普通文件不受影响
    expect(rels).not.toContain('id_rsa'); // 未放开的秘密仍排除
    expect(rels).not.toContain('.env.local'); // 变体不随字面放开联动
  });
});

/* ---------------- prunePlan 纯函数（构造 manifest 字面量，零文件 IO） ---------------- */

/** 造 manifest 字面量：每文件 hash 唯一占 size 字节（字节计帽确定性） */
function planManifest(sessionId: string, id: string, time: number, bytes: number): CheckpointManifest {
  return {
    id,
    sessionId,
    time,
    triggerTool: 'write',
    guard: false,
    forkSeq: null,
    triggerText: null,
    files: [{ rel: `${id}.txt`, hash: `hash-${id}`, size: bytes, mtimeMs: time, mode: 0o644 }],
    skipped: [],
    newBytes: bytes,
    totalBytes: bytes,
  };
}

/** 裁剪配置捷径（两帽值直给——软帽场景字节帽是主变量） */
const opts = (maxSnapshots: number, maxTotalBytes: number): PruneOptions => ({ maxSnapshots, maxTotalBytes });

describe('prunePlan：每会话 maxSnapshots 帽', () => {
  it('会话 A 五条 maxSnapshots=3 → 最旧两条被弃（时间 asc 溢出端）', () => {
    const all = [1, 2, 3, 4, 5].map((t) => planManifest('A', `cp-${t}${'0'.repeat(6)}`, t * 1000, 10));
    const drop = prunePlan(all, opts(3, 1e9), new Set(['A']));
    expect(drop.map((m) => m.id).sort()).toEqual(['cp-1000000', 'cp-2000000'].sort());
  });
});

describe('prunePlan：全局软帽跨会话 oldest-first', () => {
  it('幸存字节超帽 → 按 time asc 跨会话续弃至帽内', () => {
    // 两会话各两条、每条独占 100 字节：幸存 400、帽 300 → 最旧一条被弃
    const all = [
      planManifest('A', 'cp-a1', 1000, 100),
      planManifest('B', 'cp-b1', 2000, 100),
      planManifest('A', 'cp-a2', 3000, 100),
      planManifest('B', 'cp-b2', 4000, 100),
    ];
    const drop = prunePlan(all, opts(10, 300), new Set(['A', 'B']));
    expect(drop.map((m) => m.id)).toEqual(['cp-a1']); // 唯一被弃 = 全局最旧
  });
});

describe('prunePlan：在册会话下界保护（软帽耗尽即止）', () => {
  it('帽压到下界以下：受保护最新一条不弃——宁可超帽不自剪成「无快照」', () => {
    // 帽 100 但两在册会话各保一条最新（合计 200）：旧两条被弃后无候选即止
    const all = [
      planManifest('A', 'cp-a1', 1000, 100),
      planManifest('B', 'cp-b1', 2000, 100),
      planManifest('A', 'cp-a2', 3000, 100),
      planManifest('B', 'cp-b2', 4000, 100),
    ];
    const drop = prunePlan(all, opts(10, 100), new Set(['A', 'B']));
    expect(drop.map((m) => m.id).sort()).toEqual(['cp-a1', 'cp-b1'].sort()); // 只弃旧两条
    // 最新两条（cp-a2 / cp-b2）幸存——软帽语义：下界优先于帽
  });

  it('共享 blob 去重计字节：两条 manifest 同 hash 只计一次，帽不误触发', () => {
    // 同会话两条共享同一 blob（未变文件引用既有 hash 的常态）——实际占用 100
    const entry = { rel: 'a.txt', hash: 'hash-shared', size: 100, mtimeMs: 1, mode: 0o644 };
    const m1 = { ...planManifest('A', 'cp-a1', 1000, 100), files: [entry] };
    const m2 = { ...planManifest('A', 'cp-a2', 2000, 100), files: [entry] };
    // 帽 150：不去重会算 200 > 150 误弃 cp-a1；去重后 100 ≤ 150 → 零弃
    const drop = prunePlan([m1, m2], opts(10, 150), new Set(['A']));
    expect(drop).toEqual([]);
  });
});

describe('prunePlan：不可达会话无下界（CR-8——孤儿 manifest 不钉住 blob）', () => {
  it('在册只 A：B 全弃可达（含 B 最新）；A 最新受保护幸存', () => {
    const all = [
      planManifest('A', 'cp-a1', 1000, 100),
      planManifest('B', 'cp-b1', 2000, 100),
      planManifest('A', 'cp-a2', 3000, 100),
      planManifest('B', 'cp-b2', 4000, 100),
    ];
    // 帽 100：受保护仅 cp-a2；asc 依次弃 cp-a1 → cp-b1 → cp-b2 后恰好帽内
    const drop = prunePlan(all, opts(10, 100), new Set(['A']));
    expect(drop.map((m) => m.id).sort()).toEqual(['cp-a1', 'cp-b1', 'cp-b2'].sort());
    // B 会话整族被清（不可达 = 无下界），A 留 cp-a2
  });
});

describe('executePrune：删 manifest + 引用计数清孤 blob', () => {
  it('每会话帽裁剪落地：旧 manifest 文件消失、其独占 blob 清扫、幸存引用 blob 保留', async () => {
    const ws = join(root, 'ws-prune');
    const store = join(root, 'store-prune');
    mkdirSync(ws, { recursive: true });
    try {
      const snap = (sessionId: string) =>
        captureSnapshot(
          { dataRoot: store, workspaceRoot: ws, exclude: ['node_modules/', '.git/'] },
          { sessionId, triggerTool: 'write', guard: false, forkSeq: null, triggerText: null },
        );
      // 三连拍：a.txt 内容演进 v1 → v2（hash 各异、blob 各异）
      writeFileSync(join(ws, 'a.txt'), 'v1', 'utf8');
      const m1 = await snap('sess-prune');
      await tick();
      writeFileSync(join(ws, 'a.txt'), 'v2-long', 'utf8');
      const m2 = await snap('sess-prune');
      await tick();
      writeFileSync(join(ws, 'a.txt'), 'v3-longest', 'utf8');
      const m3 = await snap('sess-prune');
      const all = await listSessionManifests(store, 'sess-prune');
      expect(all.map((m) => m.id).sort()).toEqual([m1.id, m2.id, m3.id].sort());
      // 裁剪：每会话只保 1 条（最新 m3）
      const drop = prunePlan(all, opts(1, 1e9), new Set(['sess-prune']));
      expect(drop.map((m) => m.id).sort()).toEqual([m1.id, m2.id].sort());
      await executePrune(store, drop);
      // manifest 面：只剩 m3
      const survivors = await listSessionManifests(store, 'sess-prune');
      expect(survivors.map((m) => m.id)).toEqual([m3.id]);
      // blob 面：m3 引用的 v3 blob 在；v1/v2 独占 blob 已清孤
      const hashV3 = hashContent(Buffer.from('v3-longest', 'utf8'));
      await expect(readBlob(store, hashV3)).resolves.toBeTruthy();
      const hashV1 = hashContent(Buffer.from('v1', 'utf8'));
      await expect(readBlob(store, hashV1)).rejects.toThrow();
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  it('清孤保护（复盘 E-1 回归锁）：损坏 manifest 在场 = 弃项独占 blob 不清扫；处置后恢复清孤', async () => {
    const ws = join(root, 'ws-prot');
    const store = join(root, 'store-prot');
    mkdirSync(ws, { recursive: true });
    try {
      const snap = (sessionId: string) =>
        captureSnapshot(
          { dataRoot: store, workspaceRoot: ws, exclude: ['node_modules/', '.git/'] },
          { sessionId, triggerTool: 'write', guard: false, forkSeq: null, triggerText: null },
        );
      // 两连拍：v1 → v2（v1 blob 只被旧 manifest 独占引用）
      writeFileSync(join(ws, 'a.txt'), 'prot-v1', 'utf8');
      await snap('sess-prot');
      await tick();
      writeFileSync(join(ws, 'a.txt'), 'prot-v2-longer', 'utf8');
      await snap('sess-prot');
      const hashV1 = hashContent(Buffer.from('prot-v1', 'utf8'));
      // 混入损坏 manifest 文件（截断 JSON——损坏账非空）
      writeFileSync(manifestPath(store, 'sess-prot', 'cp-rot00001'), '{ 截断残留');
      const inventory = await listAllManifests(store);
      expect(inventory.corruptFiles).toHaveLength(1);
      // 裁剪掉 m1：损坏在场 → manifest 照删但 v1 独占 blob 必须幸存（保护模式——
      // 修复前此处红：清孤把损坏 manifest 引用面外的 blob 一律当孤儿销毁）
      await executePrune(store, prunePlan(inventory.manifests, opts(1, 1e9), new Set(['sess-prot'])));
      await expect(readBlob(store, hashV1)).resolves.toBeTruthy();
      // 人工处置（删除损坏文件）后：保护解除，下轮清孤恢复正常（v1 blob 此刻成真孤儿）
      rmSync(manifestPath(store, 'sess-prot', 'cp-rot00001'));
      const clean = await listAllManifests(store);
      expect(clean.corruptFiles).toHaveLength(0);
      await executePrune(store, []);
      await expect(readBlob(store, hashV1)).rejects.toThrow();
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });
});

describe('executePrune：清孤竞速收口（全面复盘 20260903 #1）', () => {
  /** 本组捷径捕获（独立 ws/store 对——不与共享 workspace 互染） */
  const snapAt = (ws: string, store: string, sessionId: string) =>
    captureSnapshot(
      { dataRoot: store, workspaceRoot: ws, exclude: ['node_modules/', '.git/'] },
      { sessionId, triggerTool: 'write', guard: false, forkSeq: null, triggerText: null },
    );

  it('时点重读：调用时点清单看不见的并发新 manifest，其 blob 不被清孤（修前红=签名缺位 TypeError）', async () => {
    const ws = join(root, 'ws-race1');
    const store = join(root, 'store-race1');
    mkdirSync(ws, { recursive: true });
    try {
      // 会话 A 两连拍（v1 → v2 各独占 blob）：v1 是本轮裁剪的弃项、v2 幸存
      writeFileSync(join(ws, 'a.txt'), 'race1-v1', 'utf8');
      await snapAt(ws, store, 'sess-a');
      await tick();
      writeFileSync(join(ws, 'a.txt'), 'race1-v2-longer', 'utf8');
      await snapAt(ws, store, 'sess-a');
      // 调用时点清单：此刻看不见 B 的 manifest（并发捕获「blob 先落、manifest 后落」
      // 竞速窗口的另一半——A 的 listAllManifests 恰在 B manifest 落盘前读）
      const stale = await listAllManifests(store);
      expect(stale.manifests).toHaveLength(2);
      // B 的 manifest「后落」：引用 a.txt 同 blob + 新 b.txt blob
      writeFileSync(join(ws, 'b.txt'), 'race1-b-new', 'utf8');
      const mB = await snapAt(ws, store, 'sess-b');
      // A 的顺手裁剪按陈旧清单执行（弃 A 旧快照；幸存集采信 stale = 空）
      const drop = prunePlan(stale.manifests, opts(1, 1e9), new Set(['sess-a']));
      expect(drop).toHaveLength(1);
      await executePrune(store, drop);
      // 修前真形（探针 /tmp/berry-scan9/probes/storage/sweep-race.mts 已证）：清孤
      // 幸存集 = 陈旧清单 ∖ 弃项 = 空 → B 的 blob 全判孤删 → manifest 悬空 /
      // /rewind ENOENT。修后：sweep 前时点重读全局清单，B 的 manifest 引用即时可见
      for (const f of mB.files) {
        await expect(readBlob(store, f.hash)).resolves.toBeTruthy();
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  it('在飞保护注册表：捕获进行中（blob 已落、manifest 未落）的 blob 不被清孤（修前红=签名缺位 TypeError）', async () => {
    const ws = join(root, 'ws-race2');
    const store = join(root, 'store-race2');
    mkdirSync(ws, { recursive: true });
    // 在飞捕获 promise（try 外声明——finally 块要等它落定再清场）
    let capture: Promise<CheckpointManifest> | undefined;
    try {
      // 四个 6MiB 大文件：首 blob 落盘后余下文件的读+hash 拉出真时长中窗（毫秒级，
      // 1ms 轮询必命中——窗口内任何清单视图都看不见 B 的 manifest，只有注册表能护）
      const sixMiB = (b: number) => Buffer.alloc(6 * 1024 * 1024, b);
      writeFileSync(join(ws, 'b0.bin'), sixMiB(0x61));
      for (let i = 1; i <= 3; i++) writeFileSync(join(ws, `b${i}.bin`), sixMiB(0x60 + i));
      capture = snapAt(ws, store, 'sess-b2');
      // 中窗探测：blobs/ 已出现实文件 && B 的 manifest 目录仍缺席（真形中窗 =
      // 探针形态「hX 落盘、M_B 未落」——修前清孤在此窗删 blob 即真数据丢失）
      const blobsRoot = join(store, 'blobs');
      const manifestDir = join(store, 'manifests', 'sess-b2');
      for (;;) {
        // blobs/ 未建（首 blob 未落）＝ ENOENT 视作零落地
        let count = 0;
        try {
          count = readdirSync(blobsRoot, { recursive: true }).filter((n) => !n.includes('.')).length;
        } catch {
          count = 0;
        }
        if (count > 0 && !existsSync(manifestDir)) break;
        if (existsSync(manifestDir)) break; // 窗口已过（防御——此形态下测试退化为平凡绿）
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      // 窗口内他方顺手裁剪：此刻执行清孤，唯一护栏 = 在飞捕获注册表
      await executePrune(store, []);
      const mB = await capture;
      // 修前真形：注册表缺席 → B 已落 blob 判孤删除 → manifest 悬空。修后：decision
      // 时点登记的 hash 全集进清孤白名单，manifest 落盘即注销（真孤儿照常回收）
      for (const f of mB.files) {
        await expect(readBlob(store, f.hash)).resolves.toBeTruthy();
      }
    } finally {
      // 先等在飞捕获落定再清场（否则 finally 拆工作区引爆未决 readFile——红跑同样守序）
      await capture?.catch(() => {});
      rmSync(ws, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });
});
