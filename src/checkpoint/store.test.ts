/**
 * L3 checkpoint 单元测试（store.ts 物理层半边）——blob 内容寻址幂等 / manifest
 * 写读回环与排序稳定化 / 损坏 JSON 跳过不炸 / 引用计数清孤 / 删除幂等。
 * hermetic：临时目录作数据根，用后即清。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from '../contracts/errors.js';
import {
  deleteManifest,
  ensureLayout,
  hashContent,
  listAllManifests,
  listSessionManifests,
  manifestPath,
  newManifestId,
  readBlob,
  sweepOrphanBlobs,
  writeBlob,
  writeManifest,
  type CheckpointManifest,
} from './store.js';

/** 临时数据根（全文件共享，结束后整体清除） */
let dataRoot: string;
beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'checkpoint-store-test-'));
});
afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

/** 造一份最小合法 manifest（可选覆盖字段——files 空集即零引用） */
function makeManifest(overrides: Partial<CheckpointManifest> = {}): CheckpointManifest {
  return {
    id: newManifestId(),
    sessionId: 'sess-a',
    time: 1755900000000,
    triggerTool: 'write',
    guard: false,
    forkSeq: null,
    triggerText: null,
    files: [],
    skipped: [],
    newBytes: 0,
    totalBytes: 0,
    ...overrides,
  };
}

describe('id 与哈希原语', () => {
  it('newManifestId：cp- 前缀 + 8 位 hex，两次不撞', () => {
    const a = newManifestId();
    const b = newManifestId();
    expect(a).toMatch(/^cp-[0-9a-f]{8}$/);
    expect(b).toMatch(/^cp-[0-9a-f]{8}$/);
    expect(a).not.toBe(b); // 随机前缀防并发撞名（manifest 键全库唯一）
  });

  it('hashContent = sha256 hex（与 node:crypto 直算一致）', () => {
    const content = Buffer.from('berry checkpoint 哈希', 'utf8');
    expect(hashContent(content)).toBe(createHash('sha256').update(content).digest('hex'));
  });
});

describe('blob 内容寻址（写幂等 + 读回环）', () => {
  it('首写返回 true（实际落盘）；同 hash 再写返回 false（stat 命中零写）', async () => {
    await ensureLayout(dataRoot);
    const content = Buffer.from('内容寻址幂等', 'utf8');
    const hash = hashContent(content);
    expect(await writeBlob(dataRoot, hash, content)).toBe(true);
    // 二次写：目标已存在即 no-op——newBytes 计数的正确性根基
    expect(await writeBlob(dataRoot, hash, content)).toBe(false);
    // 读回内容一致（恢复路消费面）
    expect((await readBlob(dataRoot, hash)).equals(content)).toBe(true);
  });

  it('不同内容各落各的 blob（分桶目录 = hash 前两字符）', async () => {
    const a = Buffer.from('first', 'utf8');
    const b = Buffer.from('second', 'utf8');
    const ha = hashContent(a);
    const hb = hashContent(b);
    await writeBlob(dataRoot, ha, a);
    await writeBlob(dataRoot, hb, b);
    expect((await readBlob(dataRoot, ha)).toString()).toBe('first');
    expect((await readBlob(dataRoot, hb)).toString()).toBe('second');
    // 分桶断言：两 hash 首两字符即桶名（结构面——防未来改动破坏两级分桶）
    const buckets = readdirSync(join(dataRoot, 'blobs'));
    expect(buckets).toContain(ha.slice(0, 2));
    expect(buckets).toContain(hb.slice(0, 2));
  });

  it('读侧 sha256 校验：blob 被篡改 → 拒读点名 CHECKPOINT_BLOB_CORRUPT（成熟度扫描 20260901 P1-6）', async () => {
    // 内容寻址仓的承诺：文件名即 hash。磁盘上的 blob 与其名字不符（掉电撕裂/
    // 外部损坏）时，恢复面绝不能把撕裂数据静默当快照内容写回工作区——读侧必复核。
    const content = Buffer.from('integrity 原文', 'utf8');
    const hash = hashContent(content);
    expect(await writeBlob(dataRoot, hash, content)).toBe(true);
    // 直接篡改磁盘 blob（绕过写面——模拟撕裂/外部损坏形态）
    writeFileSync(join(dataRoot, 'blobs', hash.slice(0, 2), hash), '撕裂的假内容');
    // 修前形态：readBlob 原样返回损坏内容（零校验）——本测红即证缺陷在场。
    // 断言形态同 apply-patch.test 先例：AppError 码在 .code 属性（非 message 前缀）
    const err = await readBlob(dataRoot, hash).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('CHECKPOINT_BLOB_CORRUPT');
  });
});

describe('manifest 写读回环', () => {
  it('writeManifest + listSessionManifests 回环：字段逐项一致', async () => {
    const m = makeManifest({
      files: [{ rel: 'a.txt', hash: hashContent(Buffer.from('x')), size: 1, mtimeMs: 1.5, mode: 0o644 }],
      skipped: ['big.bin'],
      newBytes: 1,
      totalBytes: 1,
    });
    await writeManifest(dataRoot, m);
    const list = await listSessionManifests(dataRoot, m.sessionId);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(m); // JSON 回环无损
  });

  it('排序：时间降序为主键；同 time 以 id 字典序稳定化', async () => {
    const base = 1755900000000;
    // 三条 manifest：旧（base+1000）、新（base+2000，id 靠后）、与新同 time（id 靠前）
    // ——写入目录序与展示序无关（readdir 天然无序）
    const older = makeManifest({ id: 'cp-99999999', sessionId: 'sess-order', time: base + 1000 });
    const newer = makeManifest({ id: 'cp-zzzzzzzz', sessionId: 'sess-order', time: base + 2000 });
    const sameTimeSmallerId = makeManifest({ id: 'cp-aaaaaaaa', sessionId: 'sess-order', time: base + 2000 });
    for (const m of [older, newer, sameTimeSmallerId]) await writeManifest(dataRoot, m);
    const list = await listSessionManifests(dataRoot, 'sess-order');
    // 降序：base+2000 两条在前（同 time 组内 id 字典序升序稳定化），base+1000 殿后
    expect(list.map((m) => m.id)).toEqual(['cp-aaaaaaaa', 'cp-zzzzzzzz', 'cp-99999999']);
  });
});

describe('损坏 manifest 跳过不炸', () => {
  it('目录内混入截断 JSON 与空文件 = 清单跳过、合法项保留', async () => {
    const good = makeManifest({ sessionId: 'sess-corrupt' });
    await writeManifest(dataRoot, good);
    // 手工造两个损坏文件：非 JSON 文本 + 形状不符的合法 JSON（缺 triggerTool 字段）
    writeFileSync(manifestPath(dataRoot, 'sess-corrupt', 'cp-bad00001'), '{ 截断的半写残留');
    writeFileSync(
      manifestPath(dataRoot, 'sess-corrupt', 'cp-bad00002'),
      JSON.stringify({ id: 'cp-bad00002', sessionId: 'sess-corrupt' }),
    );
    const list = await listSessionManifests(dataRoot, 'sess-corrupt');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(good.id); // 单文件损坏不拖垮清单面
    // 跨会话视图同律（listAllManifests 复用同一解析路径）
    const all = await listAllManifests(dataRoot);
    expect(all.manifests.some((m) => m.id === 'cp-bad00001')).toBe(false);
    expect(all.manifests.some((m) => m.id === good.id)).toBe(true);
  });

  it('损坏文件 warn 点名落痕（复盘 E-1 回归锁：静默消失 = 数据面不可审计）', async () => {
    await writeManifest(dataRoot, makeManifest({ sessionId: 'sess-warn' }));
    writeFileSync(manifestPath(dataRoot, 'sess-warn', 'cp-warn0001'), '{ 截断');
    const warns: string[] = [];
    await listSessionManifests(dataRoot, 'sess-warn', { warn: (msg) => warns.push(msg) });
    // 损坏文件点名（文件名进消息——操作者据此人工处置）；合法项不产 warn
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('cp-warn0001');
    expect(warns[0]).toContain('损坏');
  });

  it('全局清单视图携带损坏账（复盘 E-1 回归锁：损坏非空驱动清孤保护）', async () => {
    await writeManifest(dataRoot, makeManifest({ sessionId: 'sess-invent' }));
    writeFileSync(manifestPath(dataRoot, 'sess-invent', 'cp-inv00001'), 'garbage');
    const inventory = await listAllManifests(dataRoot);
    expect(inventory.corruptFiles).toContain('sess-invent/cp-inv00001.json');
    // 合法活集不含损坏项（保护判据与活集正交）；损坏账键 = 会话前缀相对名
    expect(inventory.manifests.some((m) => m.id.startsWith('cp-inv'))).toBe(false);
    expect(inventory.corruptFiles.every((f) => f.includes('/'))).toBe(true);
  });
});

describe('listSessionManifests 空态', () => {
  it('会话目录缺失 = 空数组（从未拍过快照不炸）', async () => {
    expect(await listSessionManifests(dataRoot, 'sess-never-exists')).toEqual([]);
  });
});

describe('deleteManifest 幂等', () => {
  it('删除在册 manifest 后清单消失；再删（ENOENT）不抛', async () => {
    const m = makeManifest({ sessionId: 'sess-del' });
    await writeManifest(dataRoot, m);
    expect((await listSessionManifests(dataRoot, 'sess-del')).map((x) => x.id)).toContain(m.id);
    await deleteManifest(dataRoot, m.sessionId, m.id);
    expect((await listSessionManifests(dataRoot, 'sess-del')).map((x) => x.id)).not.toContain(m.id);
    // rm force 幂等：prune 重试路径不因残留缺失炸
    await expect(deleteManifest(dataRoot, m.sessionId, m.id)).resolves.toBeUndefined();
  });
});

describe('sweepOrphanBlobs 引用计数清孤', () => {
  it('两 manifest 共享同一 blob：删其一、幸存其一 = blob 保留；全删 = blob 清扫', async () => {
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-sweep-test-'));
    try {
      const content = Buffer.from('共享 blob 内容', 'utf8');
      const hash = hashContent(content);
      await writeBlob(root, hash, content);
      const lone = Buffer.from('孤儿 blob', 'utf8');
      const loneHash = hashContent(lone);
      await writeBlob(root, loneHash, lone);
      // 两份 manifest 都引用 hash（blob 共享是常态——未变文件引用既有 blob）
      const entry = { rel: 'a.txt', hash, size: content.length, mtimeMs: 1, mode: 0o644 };
      const m1 = makeManifest({ id: 'cp-11111111', sessionId: 'sess-s1', files: [entry] });
      const m2 = makeManifest({ id: 'cp-22222222', sessionId: 'sess-s2', files: [entry] });
      // 幸存集 = [m1]：共享 blob 保留（m2 也引用但已被 prune 删——引用计数只看幸存者）、孤儿清
      const removedFirst = await sweepOrphanBlobs(root, [m1]);
      expect(removedFirst).toBe(1); // 只清了 loneHash
      await expect(readBlob(root, hash)).resolves.toBeTruthy(); // 共享 blob 在
      // 幸存集 = []：全部清扫（含共享 blob——已无任何 manifest 引用）
      const removedAll = await sweepOrphanBlobs(root, []);
      expect(removedAll).toBe(1); // 只剩 hash 一个
      await expect(readBlob(root, hash)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blobs 根缺失（从未写过）= 返回 0 不炸', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'checkpoint-sweep-empty-'));
    try {
      expect(await sweepOrphanBlobs(empty, [])).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
