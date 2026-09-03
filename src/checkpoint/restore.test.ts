/**
 * L3 checkpoint 单元测试（restore.ts 恢复半边）——遗漏大扫 20260901-c #5 回归锁。
 *
 * 恢复写段持 per-canonical-path 写串行链（运行时骨架篇 §7.5② 链覆盖的第四写者）：
 * 链键 = manifest 路径对 workspaceRoot 的 canonical 化——与工具 write/edit 同键
 * 同链。锁的属性：同键链被占用时恢复排队不落盘（裸写形态〔修前〕直接覆写——
 * 与在飞工具写交叠即撕裂混合两态）。hermetic：临时目录作双根，用后即清。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalize, serializeWrites } from '../tools/fs.js';
import { AppError } from '../contracts/errors.js';
import { restoreWorkspace } from './restore.js';
import { executePrune } from './snapshot.js';
import { hashContent, newManifestId, writeBlob, writeManifest, type CheckpointManifest } from './store.js';

/** 数据根（blob 仓共享，结束后整体清除） */
let dataRoot: string;
beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'checkpoint-restore-test-'));
});
afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('restoreWorkspace（写串行链义务——遗漏大扫 20260901-c #5）', () => {
  it('同键链被工具写占用时恢复排队：占链期间零落盘，释放后才覆写', async () => {
    // 独立工作区（本用例专享——避免与他用例链键交叠）
    const ws = mkdtempSync(join(tmpdir(), 'checkpoint-restore-ws-'));
    try {
      // 快照内容 v1 入 blob 仓 + 手工 manifest（单文件 a.txt）
      const v1 = Buffer.from('v1-快照内容');
      const hash = hashContent(v1);
      await writeBlob(dataRoot, hash, v1);
      const target: CheckpointManifest = {
        id: newManifestId(),
        sessionId: 'sess-restore-test',
        time: 1755900000000,
        triggerTool: 'write',
        guard: false,
        forkSeq: null,
        triggerText: null,
        files: [{ rel: 'a.txt', hash, size: v1.length, mtimeMs: 1, mode: 0o644 }],
        skipped: [],
        newBytes: v1.length,
        totalBytes: v1.length,
      };
      // A1 起恢复锁内核验 manifest 在场性——夹具须把目标 manifest 落盘
      await writeManifest(dataRoot, target);
      // 现场态：a.txt 已是 v2（将被回退覆写的受害者）
      writeFileSync(join(ws, 'a.txt'), 'v2-现场内容');

      // 同键先占链（模拟同会话 run 的 write 工具段在飞）：链键 = canonical 物理路径
      //（与 restoreWorkspace 内部同源同算——canonicalize 此时 a.txt 存在，走 realpath）
      const key = await canonicalize(join(ws, 'a.txt'));
      let release!: () => void;
      const holder = serializeWrites([key], () => new Promise<void>((resolve) => (release = resolve)));

      let settled = false;
      const restoring = restoreWorkspace(ws, dataRoot, target, []).then((report) => {
        settled = true;
        return report;
      });

      // 泵事件循环 ~200ms：占链未放期间恢复不得完成（裸写形态此处即落盘——红）
      for (let i = 0; i < 20 && !settled; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(settled).toBe(false);
      expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v2-现场内容');

      // 释放占链：恢复获准落盘，内容回 v1
      release();
      await holder;
      const report = await restoring;
      expect(report.restored).toBe(1);
      expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v1-快照内容');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('blob 损坏 → 恢复整体中止：拒读点名 + 现场内容不动（成熟度扫描 20260901 P1-6）', async () => {
    // 读侧 sha256 校验的恢复面锁：blob 与其名字（承诺 hash）不符时，恢复必须
    // fail-loud 中止——撕裂数据绝不静默写进工作区；「恢复失败不 fork」同句同判
    // （快照保留可重试），现场文件保持恢复前状态。
    const ws = mkdtempSync(join(tmpdir(), 'checkpoint-restore-corrupt-'));
    try {
      const v1 = Buffer.from('v1-快照内容');
      const hash = hashContent(v1);
      await writeBlob(dataRoot, hash, v1);
      // 篡改磁盘 blob（掉电撕裂/外部损坏形态——文件名承诺 hash、内容已非该 hash）
      writeFileSync(join(dataRoot, 'blobs', hash.slice(0, 2), hash), '撕裂数据');
      const target: CheckpointManifest = {
        id: newManifestId(),
        sessionId: 'sess-restore-corrupt-test',
        time: 1755900000000,
        triggerTool: 'write',
        guard: false,
        forkSeq: null,
        triggerText: null,
        files: [{ rel: 'a.txt', hash, size: v1.length, mtimeMs: 1, mode: 0o644 }],
        skipped: [],
        newBytes: v1.length,
        totalBytes: v1.length,
      };
      await writeManifest(dataRoot, target); // A1 在场性核验——夹具落盘
      // 现场态：a.txt = v2（若校验缺席，撕裂数据将覆写此文件——修前形态）
      writeFileSync(join(ws, 'a.txt'), 'v2-现场内容');

      // 恢复整体中止（readBlob 抛 CHECKPOINT_BLOB_CORRUPT 经 serializeWrites 透传）。
      // 断言形态同 apply-patch.test 先例：AppError 码在 .code 属性（非 message 前缀）
      const err = await restoreWorkspace(ws, dataRoot, target, []).catch((e: unknown) => e);
      expect((err as AppError).code).toBe('CHECKPOINT_BLOB_CORRUPT');
      // 现场未被撕裂数据覆写（恢复中止 = 半事务零落盘；快照保留可重试）
      expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v2-现场内容');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('restoreWorkspace（段内目标漂移重验——遗漏大扫 20260902-b #10）', () => {
  it('链外定键后目标被换成指向区外的符号链 → 段内重验抛 FS_WRITE_TARGET_DRIFTED 整体中止、区外零落盘', async () => {
    // 修前形态：链键在临界段外定（T0），段内 readBlob await 撑宽窗口——链外
    // 写者把 a.txt 换成指向区外的符号链后，writeFile 在 open 时重新解析，恢复
    // 字节落到链键与 manifest 都不曾锚定的区外目标（宿主信任级恢复写引出
    // 工作区）。修后：writeFile 前重跑 canonicalize 与定键比对，漂移即拒。
    const ws = mkdtempSync(join(tmpdir(), 'checkpoint-restore-drift-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'checkpoint-restore-drift-out-'));
    try {
      // 内容取本用例唯一串：内容寻址仓跨用例共享——与「blob 损坏」用例同内容
      // 会命中其故意污染的同名 blob（坏 hash 混进本用例先炸 CORRUPT）
      const v1 = Buffer.from('v1-快照内容-漂移窗');
      const hash = hashContent(v1);
      await writeBlob(dataRoot, hash, v1);
      const target: CheckpointManifest = {
        id: newManifestId(),
        sessionId: 'sess-restore-drift-test',
        time: 1755900000000,
        triggerTool: 'write',
        guard: false,
        forkSeq: null,
        triggerText: null,
        files: [{ rel: 'a.txt', hash, size: v1.length, mtimeMs: 1, mode: 0o644 }],
        skipped: [],
        newBytes: v1.length,
        totalBytes: v1.length,
      };
      await writeManifest(dataRoot, target); // A1 在场性核验——夹具落盘
      writeFileSync(join(ws, 'a.txt'), 'v2-现场内容');
      // 区外受害目标必须**存在**（canonicalize 对指向不存在目标的符号链走祖先
      // 回退拼尾段——与原键同串检不出漂移；指向存在文件时 realpath 穿透解析
      // 出区外真身，漂移可检）
      writeFileSync(join(outsideDir, 'victim.txt'), '区外现场-不可被动');

      // T0 定键（a.txt 还是真身）→ 占链 → 恢复入队（段被链挡在 T0 之后）
      const key = await canonicalize(join(ws, 'a.txt'));
      let release!: () => void;
      const holder = serializeWrites([key], () => new Promise<void>((r) => (release = r)));
      const restoring = restoreWorkspace(ws, dataRoot, target, []);
      await new Promise((resolve) => setTimeout(resolve, 20)); // 让 T0 定键+入队完成

      // 链外写者的 symlink swap：真身换符号链（发生在定键之后、恢复段进入前）
      rmSync(join(ws, 'a.txt'));
      symlinkSync(join(outsideDir, 'victim.txt'), join(ws, 'a.txt'));

      release(); // 放链——恢复段进入，writeFile 前的段内重验面对已漂移目标
      await holder;
      const err = await restoring.catch((e: unknown) => e);
      expect((err as AppError).code).toBe('FS_WRITE_TARGET_DRIFTED'); // 断言形态同上用例先例
      // 区外零落盘（宿主信任级恢复写不引出工作区——修前红：victim 被覆写成 v1）
      expect(readFileSync(join(outsideDir, 'victim.txt'), 'utf8')).toBe('区外现场-不可被动');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('restoreWorkspace（恢复段物理写序——遗漏大扫 20260902-c #8）', () => {
  it('父组件被换成指向区外目录的符号链 → mkdir 前重验即拒：区外目录树零创建（修前 mkdir 先建区外再拒写）', async () => {
    // 修前形态：段内序 = mkdir → 重验 → writeFile。目标父组件（sub）在定键后被
    // 链外写者换成指向区外已存在目录的符号链、且深层目录（deep）尚不存在时，
    // mkdir recursive 顺着符号链把 deep 建到区外真身——随后的重验虽拒掉文件写
    //（DRIFTED），区外目录已留痕。修后：重验 → mkdir → 复验 → writeFile——
    // 首验即拒，区外零创建。
    const ws = mkdtempSync(join(tmpdir(), 'checkpoint-restore-mkdir-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'checkpoint-restore-mkdir-out-'));
    try {
      // 深层路径（sub/deep/inner.txt——mkdir 真有目录要建）；T0 时 sub 整个不存在
      const v1 = Buffer.from('v1-快照内容-mkdir序');
      const hash = hashContent(v1);
      await writeBlob(dataRoot, hash, v1);
      const target: CheckpointManifest = {
        id: newManifestId(),
        sessionId: 'sess-restore-mkdir-test',
        time: 1755900000000,
        triggerTool: 'write',
        guard: false,
        forkSeq: null,
        triggerText: null,
        files: [{ rel: 'sub/deep/inner.txt', hash, size: v1.length, mtimeMs: 1, mode: 0o644 }],
        skipped: [],
        newBytes: v1.length,
        totalBytes: v1.length,
      };
      await writeManifest(dataRoot, target); // A1 在场性核验——夹具落盘

      // T0 定键（sub 不存在——canonicalize 祖先回退拼尾段）→ 占链 → 恢复入队
      const key = await canonicalize(join(ws, 'sub', 'deep', 'inner.txt'));
      let release!: () => void;
      const holder = serializeWrites([key], () => new Promise<void>((r) => (release = r)));
      const restoring = restoreWorkspace(ws, dataRoot, target, []);
      await new Promise((resolve) => setTimeout(resolve, 20)); // 让 T0 定键+入队完成

      // 链外写者的 symlink swap：sub 换成指向区外已存在目录的符号链（deep 尚
      // 不存在——mkdir 若先跑会穿透符号链在区外建出 deep）
      symlinkSync(outsideDir, join(ws, 'sub'));

      release(); // 放链——恢复段进入，mkdir 前首验面对已漂移父组件
      await holder;
      const err = await restoring.catch((e: unknown) => e);
      expect((err as AppError).code).toBe('FS_WRITE_TARGET_DRIFTED');
      // 区外目录树零创建（修前红：mkdir 已把 deep 建进区外真身）
      expect(existsSync(join(outsideDir, 'deep'))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('restoreWorkspace（遗留检测枚举语义——遗漏大扫 20260902-c #6）', () => {
  it('捕获剪掉的路径不当遗留误报：exclude 族 + .gitignore 面 + skipped 超限跳过全部豁免', async () => {
    // 修前形态：遗留枚举只跳 node_modules/.git 硬表——exclude 配置剪掉的
    //（secret.key）、.gitignore 剪掉的（dist/out.js、debug.log）在场时全部被
    // 点名为「快照后新建」（operator 被误导处置）；skipped 超限跳过（huge.bin
    // 捕获时已在场）同被误报。修后：枚举与捕获同一剪枝语义件内单源，真正的新建
    //（new-after.txt）照常点名。
    const ws = mkdtempSync(join(tmpdir(), 'checkpoint-restore-leftover-'));
    try {
      // 根 .gitignore：dist/ 与 *.log（捕获语义 = 逐目录 .gitignore 前缀化规则）。
      // .gitignore 自身不被剪枝、属真实快照面——manifest 带上（否则它自己成遗留）
      const gitignoreContent = 'dist/\n*.log\n';
      writeFileSync(join(ws, '.gitignore'), gitignoreContent);
      const giBuf = Buffer.from(gitignoreContent);
      const giHash = hashContent(giBuf);
      await writeBlob(dataRoot, giHash, giBuf);
      // 快照面：a.txt + .gitignore 入 manifest；huge.bin 走超限跳过（skipped 披露）
      const v1 = Buffer.from('v1-快照内容-遗留');
      const hash = hashContent(v1);
      await writeBlob(dataRoot, hash, v1);
      const target: CheckpointManifest = {
        id: newManifestId(),
        sessionId: 'sess-restore-leftover-test',
        time: 1755900000000,
        triggerTool: 'write',
        guard: false,
        forkSeq: null,
        triggerText: null,
        files: [
          { rel: 'a.txt', hash, size: v1.length, mtimeMs: 1, mode: 0o644 },
          { rel: '.gitignore', hash: giHash, size: giBuf.length, mtimeMs: 1, mode: 0o644 },
        ],
        skipped: ['huge.bin'],
        newBytes: v1.length + giBuf.length,
        totalBytes: v1.length + giBuf.length,
      };
      await writeManifest(dataRoot, target); // A1 在场性核验——夹具落盘

      // 现场态：快照后的真实新建（new-after.txt）+ 捕获各剪枝面覆盖的在场路径
      writeFileSync(join(ws, 'new-after.txt'), '快照后新建');
      writeFileSync(join(ws, 'secret.key'), '秘密-exclude 剪掉');
      writeFileSync(join(ws, 'debug.log'), '日志-gitignore 剪掉');
      mkdirSync(join(ws, 'dist'));
      writeFileSync(join(ws, 'dist', 'out.js'), '构建物-gitignore 剪掉');
      writeFileSync(join(ws, 'huge.bin'), '超限跳过-捕获时已在场');

      // exclude 与捕获同一拼接全集语义（此处用显式清单演示参数接线；缺省族
      // 由 checkpoint-stack.test 的接线级用例覆盖）
      const report = await restoreWorkspace(ws, dataRoot, target, ['secret.key']);
      expect(report.leftovers).toEqual(['new-after.txt']); // 修前红：五路全误报
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('restoreWorkspace（恢复读锁与在场性核验——第十一轮遗漏大扫 20260904-b A1）', () => {
  it('恢复在飞时并发 executePrune 排队：目标 blob 全程不被扫删（修前：清孤插进恢复中段删 manifest+blob → readBlob ENOENT 半事务）', async () => {
    // 修前形态：恢复是 blob 仓读写锁的唯一无锁消费者——恢复中段（逐路径
    // readBlob 的 await 窗）并发清孤把目标 manifest 判弃后扫删其独占 blob，
    // 恢复 ENOENT 整体抛错但**部分文件已覆写**（半事务：工作区两不沾且回执
    // 谎称「快照保留」）。修后：恢复全程持共享读锁，清孤独占排队到恢复收场。
    // 编舞：占住 a.txt 的写串行链把恢复挡在链上（读锁已持）——清孤在此期间
    // 发起；修后其 withWrite 排队（写者优先只挡新读者，不抢在飞读者）。
    const ws = mkdtempSync(join(tmpdir(), 'checkpoint-restore-rwlock-'));
    try {
      // 两文件两独占 blob（内容寻址仓跨用例共享——内容取本用例唯一串）
      const vA = Buffer.from('v1-A-恢复读锁');
      const vB = Buffer.from('v1-B-恢复读锁');
      const ha = hashContent(vA);
      const hb = hashContent(vB);
      await writeBlob(dataRoot, ha, vA);
      await writeBlob(dataRoot, hb, vB);
      const target: CheckpointManifest = {
        id: newManifestId(),
        sessionId: 'sess-restore-rwlock-test',
        time: 1755900000000,
        triggerTool: 'write',
        guard: false,
        forkSeq: null,
        triggerText: null,
        files: [
          { rel: 'a.txt', hash: ha, size: vA.length, mtimeMs: 1, mode: 0o644 },
          { rel: 'b.txt', hash: hb, size: vB.length, mtimeMs: 1, mode: 0o644 },
        ],
        skipped: [],
        newBytes: vA.length + vB.length,
        totalBytes: vA.length + vB.length,
      };
      await writeManifest(dataRoot, target);
      writeFileSync(join(ws, 'a.txt'), 'v2-A');
      writeFileSync(join(ws, 'b.txt'), 'v2-B');

      // 同键先占链（恢复的 serializeWrites 排队其后——读锁在此前已握）
      const key = await canonicalize(join(ws, 'a.txt'));
      let release!: () => void;
      const holder = serializeWrites([key], () => new Promise<void>((r) => (release = r)));
      const restoring = restoreWorkspace(ws, dataRoot, target, []);
      await new Promise((resolve) => setTimeout(resolve, 20)); // 恢复持锁入链等待

      // 并发清孤（兄弟会话 doCapture 尾部顺手裁剪形态）：弃本目标 → 锁内重读 → 扫孤
      const pruning = executePrune(dataRoot, [target]).catch(() => undefined);

      // 红锚分岔：修前（恢复无锁）清孤立即获准——blob 被实删（轮询早退）；
      // 修后清孤排队——blob 恒在场（轮询 600ms 到期）。两形都确定性
      const blobA = join(dataRoot, 'blobs', ha.slice(0, 2), ha);
      for (let i = 0; i < 60 && existsSync(blobA); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      release(); // 放链——恢复收场（修后 blob 全程在场）→ 读锁释放 → 清孤才跑
      await holder;
      const report = await restoring; // 修前红：a.txt 的 blob 已删 → readBlob ENOENT 抛错
      expect(report.restored).toBe(2);
      expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v1-A-恢复读锁');
      expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('v1-B-恢复读锁');
      await pruning;
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('锁内核验 manifest 在场性：目标已被裁剪 → 零字节写过 + 点名已被裁剪（修前：共享 blob 先覆写 → 独占 blob ENOENT 半事务）', async () => {
    // 锁外选标窗（/rewind 清单读取 → 恢复起点）内目标可已被裁剪：manifest 已删、
    // 独占 blob 已扫、共享 blob 仍在。修前恢复照跑——f0（blob 被幸存 manifest
    // 共享、仍在盘）先覆写、f1（独占 blob 已删）ENOENT 中止：工作区两不沾。
    // 修后：锁内 stat 目标 manifest 缺场即整体拒（零字节写过、点名已被裁剪）。
    const ws = mkdtempSync(join(tmpdir(), 'checkpoint-restore-gone-'));
    try {
      const vA = Buffer.from('v1-A-已裁剪共享');
      const vB = Buffer.from('v1-B-已裁剪独占');
      const ha = hashContent(vA);
      const hb = hashContent(vB);
      await writeBlob(dataRoot, ha, vA);
      await writeBlob(dataRoot, hb, vB);
      // 幸存 manifest 只引用 ha；target 不落盘（已被裁剪）+ 独占 blob 已被扫
      const survivor: CheckpointManifest = {
        id: newManifestId(),
        sessionId: 'sess-restore-gone-survivor',
        time: 1755900000000,
        triggerTool: 'write',
        guard: false,
        forkSeq: null,
        triggerText: null,
        files: [{ rel: 'f0.txt', hash: ha, size: vA.length, mtimeMs: 1, mode: 0o644 }],
        skipped: [],
        newBytes: vA.length,
        totalBytes: vA.length,
      };
      await writeManifest(dataRoot, survivor);
      rmSync(join(dataRoot, 'blobs', hb.slice(0, 2), hb), { force: true });
      const target: CheckpointManifest = {
        id: newManifestId(),
        sessionId: 'sess-restore-gone-test',
        time: 1755900000000,
        triggerTool: 'write',
        guard: false,
        forkSeq: null,
        triggerText: null,
        files: [
          { rel: 'f0.txt', hash: ha, size: vA.length, mtimeMs: 1, mode: 0o644 },
          { rel: 'f1.txt', hash: hb, size: vB.length, mtimeMs: 1, mode: 0o644 },
        ],
        skipped: [],
        newBytes: vA.length + vB.length,
        totalBytes: vA.length + vB.length,
      };
      writeFileSync(join(ws, 'f0.txt'), '现场-f0');
      writeFileSync(join(ws, 'f1.txt'), '现场-f1');

      const err = await restoreWorkspace(ws, dataRoot, target, []).catch((e: unknown) => e);
      expect((err as Error).message).toContain('已被裁剪'); // 修前红：raw ENOENT 文案
      // 零字节写过（半事务免疫）——修前红：f0 已被覆写为快照内容后才在 f1 ENOENT
      expect(readFileSync(join(ws, 'f0.txt'), 'utf8')).toBe('现场-f0');
      expect(readFileSync(join(ws, 'f1.txt'), 'utf8')).toBe('现场-f1');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
