/**
 * L3 checkpoint 单元测试（restore.ts 恢复半边）——遗漏大扫 20260901-c #5 回归锁。
 *
 * 恢复写段持 per-canonical-path 写串行链（运行时骨架篇 §7.5② 链覆盖的第四写者）：
 * 链键 = manifest 路径对 workspaceRoot 的 canonical 化——与工具 write/edit 同键
 * 同链。锁的属性：同键链被占用时恢复排队不落盘（裸写形态〔修前〕直接覆写——
 * 与在飞工具写交叠即撕裂混合两态）。hermetic：临时目录作双根，用后即清。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalize, serializeWrites } from '../tools/fs.js';
import { AppError } from '../contracts/errors.js';
import { restoreWorkspace } from './restore.js';
import { hashContent, newManifestId, writeBlob, type CheckpointManifest } from './store.js';

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
      // 现场态：a.txt 已是 v2（将被回退覆写的受害者）
      writeFileSync(join(ws, 'a.txt'), 'v2-现场内容');

      // 同键先占链（模拟同会话 run 的 write 工具段在飞）：链键 = canonical 物理路径
      //（与 restoreWorkspace 内部同源同算——canonicalize 此时 a.txt 存在，走 realpath）
      const key = await canonicalize(join(ws, 'a.txt'));
      let release!: () => void;
      const holder = serializeWrites([key], () => new Promise<void>((resolve) => (release = resolve)));

      let settled = false;
      const restoring = restoreWorkspace(ws, dataRoot, target).then((report) => {
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
      // 现场态：a.txt = v2（若校验缺席，撕裂数据将覆写此文件——修前形态）
      writeFileSync(join(ws, 'a.txt'), 'v2-现场内容');

      // 恢复整体中止（readBlob 抛 CHECKPOINT_BLOB_CORRUPT 经 serializeWrites 透传）。
      // 断言形态同 apply-patch.test 先例：AppError 码在 .code 属性（非 message 前缀）
      const err = await restoreWorkspace(ws, dataRoot, target).catch((e: unknown) => e);
      expect((err as AppError).code).toBe('CHECKPOINT_BLOB_CORRUPT');
      // 现场未被撕裂数据覆写（恢复中止 = 半事务零落盘；快照保留可重试）
      expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v2-现场内容');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
