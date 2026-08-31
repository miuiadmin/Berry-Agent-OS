/**
 * L5 app — upgrade 纯函数核心测试（技术栈篇 §8.5，第五十一批）。
 * semver 比对 / 装机形态判定 / 目标版本选择 / 指引文案——编排器（网络与
 * spawn）不在此测（进程外面，真链路由 berry upgrade 手验）。
 */

import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  detectInstallForm,
  pickTargetVersion,
  sourceUpgradeGuidance,
  unpublishedGuidance,
} from './upgrade.js';

describe('compareSemver（semver 简化比对）', () => {
  it('三段数字比大小', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemver('1.1.0', '1.0.9')).toBe(1);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });
  it('prerelease 缺席 > 在场（1.0.0 > 1.0.0-alpha.0）', () => {
    expect(compareSemver('1.0.0', '1.0.0-alpha.0')).toBe(1);
    expect(compareSemver('1.0.0-alpha.0', '1.0.0')).toBe(-1);
  });
  it('prerelease 数字段数值序（alpha.2 > alpha.10 不成立——数值比非字典序）', () => {
    expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(compareSemver('1.0.0-alpha.10', '1.0.0-alpha.2')).toBe(1);
  });
  it('prerelease 前缀相同短者小（alpha < alpha.0）', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.0')).toBe(-1);
  });
  it('非法输入按 0.0.0 兜底不抛', () => {
    expect(compareSemver('oops', '0.0.0')).toBe(0);
    expect(compareSemver('oops', '0.0.1')).toBe(-1);
  });
});

describe('detectInstallForm（装机形态判定）', () => {
  it('real path 含 node_modules 段 = npm（bin 链接解析到包内 dist）', () => {
    expect(detectInstallForm('/usr/local/lib/node_modules/berryagent/dist/app/main.js')).toBe('npm');
    expect(detectInstallForm('/Users/x/.nvm/versions/node/v22.19.0/lib/node_modules/berryagent/dist/app/main.js')).toBe(
      'npm',
    );
  });
  it('源码 clone 与 npm link（realpath 解回仓库）= source', () => {
    expect(detectInstallForm('/Users/x/code/berry/dist/app/main.js')).toBe('source');
    // npm link：bin 在全局 node_modules/.bin，realpath 已解回仓库目录
    expect(detectInstallForm('/Users/x/code/berry/src/app/main.ts')).toBe('source');
  });
});

describe('pickTargetVersion（目标版本选择——preview 期 latest 跟 alpha）', () => {
  it('latest 优先', () => {
    expect(pickTargetVersion({ latest: '1.0.0-alpha.3', next: '1.0.0-beta.1' })).toBe('1.0.0-alpha.3');
  });
  it('latest 缺席回落 next；两者皆缺 = undefined', () => {
    expect(pickTargetVersion({ next: '1.0.0-beta.1' })).toBe('1.0.0-beta.1');
    expect(pickTargetVersion({})).toBeUndefined();
  });
});

describe('指引文案', () => {
  it('源码形态：四步指引含版本与不自动执行声明', () => {
    const text = sourceUpgradeGuidance('1.0.0-alpha.0');
    expect(text).toContain('源码');
    expect(text).toContain('1.0.0-alpha.0');
    expect(text).toContain('git pull');
    expect(text).toContain('npm link');
    expect(text).toContain('不自动执行');
  });
  it('未发布态：诚实告知 + 源码升级路', () => {
    const text = unpublishedGuidance('1.0.0-alpha.0');
    expect(text).toContain('尚未发布');
    expect(text).toContain('1.0.0-alpha.0');
    expect(text).toContain('源码');
  });
});
