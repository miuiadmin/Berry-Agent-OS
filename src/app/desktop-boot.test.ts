/**
 * app — 桌面起屏熔断账本测试（第八十五批批 C，骨架篇 boot 序）。
 *
 * 四态执法面：计数累计（进程重启不清——账本在盘）/ 版本变更清零（升级自愈）/
 * 阈值判定（同版本连续 ≥2 = 熔断）/ 成功清账（用户裁决盖过机器判死）。
 * 附破坏账本形态：损坏 JSON = 零计数重启 + warn（诊断面不炸交互面）。
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOOT_BREAKER_THRESHOLD,
  DESKTOP_BOOT_FAILURES_FILE,
  bootFailuresPath,
  clearBootFailures,
  currentPackageVersion,
  isBootBreakerTripped,
  readBootFailures,
  recordBootFailure,
} from './desktop-boot.js';

/** 临时数据目录（真实账本形态——盘上文件面就是要测的本体） */
function freshDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `${prefix}-`)));
}

describe('desktop-boot 熔断账本（两连崩保护）', () => {
  it('版本锚 = package.json 实读（readFileSync 直读——不是 version.ts 字面量镜像）', () => {
    // 版本变更清账的判据锚必须与发布物同源：package.json 是 npm 发布唯一真相，
    // version.ts 是构建期镜像——镜像可漂移，实读不会
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(currentPackageVersion()).toBe(pkg.version);
    expect(currentPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('账本缺席 = 零计数起步（首装形态：从未失败过）', () => {
    const dir = freshDir('boot-ledger');
    try {
      expect(readBootFailures(dir)).toEqual({ version: currentPackageVersion(), count: 0 });
      expect(isBootBreakerTripped(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('计数累计：两次 record 后熔断（进程内连续两次失败 = 熔断回锁）', () => {
    const dir = freshDir('boot-ledger');
    try {
      const warns: string[] = [];
      const warn = (message: string) => warns.push(message);
      expect(recordBootFailure(dir, { warn }).count).toBe(1);
      expect(isBootBreakerTripped(dir)).toBe(false); // 第 1 次：不熔断（下次 boot 仍尝试桌面）
      expect(recordBootFailure(dir, { warn }).count).toBe(2);
      expect(isBootBreakerTripped(dir)).toBe(true); // 第 2 次：两连崩 → 熔断
      // 账本落盘形态：{version, count}——进程重启不清（下条用例直读盘面证）
      expect(JSON.parse(readFileSync(bootFailuresPath(dir), 'utf8'))).toEqual({
        version: currentPackageVersion(),
        count: 2,
      });
      expect(warns).toHaveLength(0); // 正常计数路径零告警
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('盘面持久：重启进程（新调用面）读同一账本——计数不清零', () => {
    const dir = freshDir('boot-ledger');
    try {
      recordBootFailure(dir, { warn: () => {} });
      // 模拟进程重启：不持内存态，直接从盘读
      expect(readBootFailures(dir).count).toBe(1);
      expect(isBootBreakerTripped(dir)).toBe(false);
      recordBootFailure(dir, { warn: () => {} });
      expect(isBootBreakerTripped(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('版本变更清账：旧版本账 2 次 → 新版本零计数不熔断（升级自愈）', () => {
    const dir = freshDir('boot-ledger');
    try {
      const warns: string[] = [];
      // 人写旧版本账本（升级后首启见到的盘面形态）
      writeFileSync(bootFailuresPath(dir), JSON.stringify({ version: '0.0.0-old', count: 99 }));
      // 版本不匹配 = 升级清零语义：静默不熔断（预期升级不是异常——零告警）
      expect(isBootBreakerTripped(dir, { warn: (m) => warns.push(m) })).toBe(false);
      expect(warns).toHaveLength(0);
      // record 遇旧版本账：清零重记（count 从 1 起步，不继承 99）
      expect(recordBootFailure(dir, { warn: () => {} }).count).toBe(1);
      expect(isBootBreakerTripped(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('成功清账：clearBootFailures 写零计数（/desktop 重试成功 = 用户裁决盖过机器判死）', () => {
    const dir = freshDir('boot-ledger');
    try {
      recordBootFailure(dir, { warn: () => {} });
      recordBootFailure(dir, { warn: () => {} });
      expect(isBootBreakerTripped(dir)).toBe(true);
      clearBootFailures(dir);
      expect(isBootBreakerTripped(dir)).toBe(false);
      expect(readBootFailures(dir).count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏账本 = 零计数重启 + warn（诊断不炸交互面——熔断面自身 fail-safe）', () => {
    const dir = freshDir('boot-ledger');
    try {
      const warns: string[] = [];
      writeFileSync(bootFailuresPath(dir), '{不是 JSON');
      expect(readBootFailures(dir, { warn: (m) => warns.push(m) })).toEqual({
        version: currentPackageVersion(),
        count: 0,
      });
      expect(warns).toHaveLength(1);
      // 熔断判据同律 fail-safe：损坏不误熔断
      expect(isBootBreakerTripped(dir, { warn: () => {} })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('常量面：阈值 2 + 文件名（boot 序文档锚）', () => {
    expect(BOOT_BREAKER_THRESHOLD).toBe(2);
    expect(DESKTOP_BOOT_FAILURES_FILE).toBe('desktop-boot-failures.json');
    expect(bootFailuresPath('/data')).toBe('/data/desktop-boot-failures.json');
  });
});
