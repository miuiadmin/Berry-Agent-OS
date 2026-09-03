/**
 * 官方清单装载门接线测试（API 治理 §6.13.4，第八十七批批 2）。
 *
 * 独立文件（不入 app-registry.test.ts）：装载门是本批新增面，专测
 * loadOfficialApps 的 hostApiVersion 覆写 / API_VERSION_MISMATCH 拒载 /
 * legacy 聚合回调三件。纯函数面（adjudicateApiGate 四出口）住
 * contracts/api.test.ts——本文件锁接线（真清单 + 真包根 apiVersion）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_VERSION_MISMATCH, APP_INVALID } from '../contracts/errors.js';
import { loadOfficialApps } from './app-registry.js';

/** 最小合法清单（api 块在场——装载门 admit 路的最小真值） */
const WITH_API = `id: gate/probe\nlabel: 门探针\ncomponents: [builtin:chat]\napi:\n  minApiVersion: "1.0"\n`;
/** 同清单去掉 api 块（legacy 态——容忍窗口内的缺席形态） */
const WITHOUT_API = `id: gate/legacy\nlabel: 旧清单\ncomponents: [builtin:chat]\n`;

/** 临时 apps 目录夹具（写清单文件群——单测隔离，不触仓内 apps/） */
function fixtureDir(manifests: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'berry-api-gate-'));
  for (const [name, text] of Object.entries(manifests)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe('loadOfficialApps 装载门接线（§6.13.4 四出口的装载面）', () => {
  it('官方清单随包恒绿：真包根 apiVersion（1.0）裁决全 admit——boot 断言不炸', () => {
    // 官方三清单批 2 已回填 min 1.0；此测同时是「回填不回退」的回归锁
    //（未来某清单 min 抬过包根即红——发版事故前兆）
    const apps = loadOfficialApps();
    expect(apps.size).toBeGreaterThan(0);
    for (const manifest of apps.values()) {
      expect(manifest.api?.minApiVersion).toBe('1.0');
    }
  });

  it('宿主 < min → API_VERSION_MISMATCH 拒载（官方件随包，版本失配 = 发版事故 fail-loud）', () => {
    try {
      loadOfficialApps(undefined, { hostApiVersion: '0.9' });
      expect.unreachable('宿主 0.9 低于官方清单地板 1.0 应拒载');
    } catch (err) {
      expect((err as { code?: unknown }).code).toBe(API_VERSION_MISMATCH);
    }
  });

  it('legacy 聚合回调：api 块缺席的清单 id per-boot 一次聚合送出（非逐清单 warn）', () => {
    const dir = fixtureDir({
      'a-legacy.app.yaml': WITHOUT_API,
      'b-with-api.app.yaml': WITH_API,
    });
    try {
      const legacyIds: string[] = [];
      const apps = loadOfficialApps(dir, { hostApiVersion: '1.0', onLegacyApps: (ids) => legacyIds.push(...ids) });
      // 装载不拒（容忍窗口）；两清单都在册
      expect(apps.size).toBe(2);
      expect(legacyIds).toEqual(['gate/legacy']); // 只缺席者、聚合一次
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legacy 清单零缺席 → 聚合回调静默不呼（零缺席零噪音——对照腿）', () => {
    const dir = fixtureDir({ 'only.app.yaml': WITH_API });
    try {
      const calls: (readonly string[])[] = [];
      loadOfficialApps(dir, { hostApiVersion: '1.0', onLegacyApps: (ids) => calls.push(ids) });
      expect(calls).toEqual([]); // 只在有缺席时聚合送出，空清单不呼
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legacy 聚合不依赖回调在场（未传 onLegacyApps 时零动作——告警面由调用方装配）', () => {
    const dir = fixtureDir({ 'a-legacy.app.yaml': WITHOUT_API });
    try {
      expect(() => loadOfficialApps(dir, { hostApiVersion: '1.0' })).not.toThrowError();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('空目录 → 空表零裁决（防御位——布局异常不炸启动面）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'berry-api-gate-empty-'));
    try {
      const legacyIds: string[] = [];
      const apps = loadOfficialApps(dir, { hostApiVersion: '1.0', onLegacyApps: (ids) => legacyIds.push(...ids) });
      expect(apps.size).toBe(0);
      expect(legacyIds).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('装载门门缝与清单校验的边界（不变式由 validateAppManifest 前置执法）', () => {
  it('min > target 倒挂清单 → APP_INVALID（schema 后置不变式，装载门前置红）', () => {
    const dir = fixtureDir({
      'bad.app.yaml': `id: gate/inverted\nlabel: 倒挂\ncomponents: [builtin:chat]\napi:\n  minApiVersion: "1.5"\n  targetApiVersion: "1.0"\n`,
    });
    try {
      try {
        loadOfficialApps(dir, { hostApiVersion: '1.0' });
        expect.unreachable('倒挂不变式应 APP_INVALID 拒');
      } catch (err) {
        expect((err as { code?: unknown }).code).toBe(APP_INVALID);
        expect((err as Error).message).toContain('地板不得高于行为锚');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('experimental 数组拼错键 → APP_INVALID（宁拒不静默——§6.13.4 后置不变式③）', () => {
    const dir = fixtureDir({
      'bad.app.yaml': `id: gate/typo\nlabel: 拼错\ncomponents: [builtin:chat]\napi:\n  minApiVersion: "1.0"\n  experimental: [berryagent-typo]\n`,
    });
    try {
      try {
        loadOfficialApps(dir, { hostApiVersion: '1.0' });
        expect.unreachable('拼错实验键应 APP_INVALID 拒');
      } catch (err) {
        expect((err as { code?: unknown }).code).toBe(APP_INVALID);
        expect((err as Error).message).toContain('berryagent-typo');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
