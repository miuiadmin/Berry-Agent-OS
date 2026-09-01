/**
 * L5 app — upgrade 测试（技术栈篇 §8.5，第五十一批 + 第五十三批补面）。
 * 纯函数核心（semver 比对 / 装机形态判定 / 目标版本选择 / 指引文案） +
 * 编排器行为面（遗漏大扫 20260901-b #8/#16：registry 同源拼接与回退、
 * verdict 五态分派、target 白名单安全线、退出码契约、npm 半态收场——
 * 注入假面，网络与 spawn 真链路仍由 berry upgrade 手验）。
 */

import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  detectInstallForm,
  detectPackageManager,
  distTagsUrlFor,
  foreignManagerGuidance,
  pickTargetVersion,
  resolveRegistryBase,
  runUpgradeCheck,
  sourceUpgradeGuidance,
  unpublishedGuidance,
  upgradeMain,
} from './upgrade.js';
import type { DistTagsResult } from './upgrade.js';
import { VERSION } from './version.js';

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

describe('detectPackageManager（npm 形态的包管理器甄别——冷读 m1 余款）', () => {
  it('npm 全局 = npm（缺省）', () => {
    expect(detectPackageManager('/usr/local/lib/node_modules/berryagent/dist/app/main.js')).toBe('npm');
  });
  it('pnpm 全局（.pnpm / pnpm-global 段）→ pnpm', () => {
    expect(
      detectPackageManager(
        '/home/x/.local/share/pnpm/global/5/.pnpm/berryagent@1.0.0/node_modules/berryagent/dist/app/main.js',
      ),
    ).toBe('pnpm');
    expect(detectPackageManager('/home/x/.pnpm-global/node_modules/berryagent/dist/app/main.js')).toBe('pnpm');
  });
  it('yarn 全局（yarn 段）→ yarn', () => {
    expect(detectPackageManager('/home/x/.config/yarn/global/node_modules/berryagent/dist/app/main.js')).toBe('yarn');
  });
  it('非 npm 管理器指引：原管理器一条命令 + 不代执行声明', () => {
    expect(foreignManagerGuidance('pnpm')).toContain('pnpm add -g berryagent');
    expect(foreignManagerGuidance('yarn')).toContain('yarn global add berryagent');
    expect(foreignManagerGuidance('pnpm')).toContain('不代执行');
  });
});

/* ---------------- 编排器与 registry 同源（遗漏大扫 20260901-b #8/#16，第五十三批） ---------------- */

describe('distTagsUrlFor（#16 判定腿端点拼接与回退）', () => {
  it('镜像源拼接 + 尾斜杠归一', () => {
    const url = 'https://registry.npmmirror.com/-/package/berryagent/dist-tags';
    expect(distTagsUrlFor('https://registry.npmmirror.com')).toBe(url);
    expect(distTagsUrlFor('https://registry.npmmirror.com/')).toBe(url);
    expect(distTagsUrlFor('https://registry.npmmirror.com//')).toBe(url);
    expect(distTagsUrlFor('  https://registry.example.com  ')).toBe(
      'https://registry.example.com/-/package/berryagent/dist-tags',
    );
  });
  it('空串/空白回退官方源（npm config 解析失败的兜底位）', () => {
    expect(distTagsUrlFor('')).toBe('https://registry.npmjs.org/-/package/berryagent/dist-tags');
    expect(distTagsUrlFor('   ')).toBe('https://registry.npmjs.org/-/package/berryagent/dist-tags');
  });
});

describe('resolveRegistryBase（#16 用户 npm 配置源解析）', () => {
  it('npm config 正常输出 → 用户源原样（含换行由调用方 trim 已吃）', async () => {
    const base = await resolveRegistryBase(async () => ({ code: 0, stdout: 'https://registry.npmmirror.com/\n' }));
    expect(base).toBe('https://registry.npmmirror.com/');
  });
  it('退出码非 0 / 空输出 → 官方源回退（解析是尽力而为不是硬前置）', async () => {
    expect(await resolveRegistryBase(async () => ({ code: 1, stdout: '' }))).toBe('https://registry.npmjs.org');
    expect(await resolveRegistryBase(async () => ({ code: 0, stdout: '\n' }))).toBe('https://registry.npmjs.org');
  });
});

describe('runUpgradeCheck（#8 verdict 五态分派——注入面直锁检查层）', () => {
  const NPM_PATH = '/usr/local/lib/node_modules/berryagent/dist/app/main.js';
  const SRC_PATH = '/repo/berry/dist/app/main.js';
  const okTags = (latest: string) => async () => ({ status: 'ok', tags: { latest } }) as const;

  it('up-to-date：本地 ≥ target', async () => {
    const check = await runUpgradeCheck(VERSION, NPM_PATH, { fetchDistTags: okTags(VERSION) });
    expect(check.verdict).toEqual({ kind: 'up-to-date', target: VERSION });
    expect(check.form).toBe('npm');
  });
  it('available：target 更高', async () => {
    const check = await runUpgradeCheck(VERSION, NPM_PATH, { fetchDistTags: okTags('9.9.9') });
    expect(check.verdict).toEqual({ kind: 'available', target: '9.9.9' });
  });
  it('source：npm 形态缺席时源码态优先于版本比较', async () => {
    const check = await runUpgradeCheck(VERSION, SRC_PATH, { fetchDistTags: okTags('9.9.9') });
    expect(check.verdict).toEqual({ kind: 'source', target: '9.9.9' });
    expect(check.form).toBe('source');
  });
  it('unpublished：registry 404 / 两 tag 皆缺同归未发布态', async () => {
    expect(
      (await runUpgradeCheck(VERSION, NPM_PATH, { fetchDistTags: async () => ({ status: 'unpublished' }) })).verdict,
    ).toEqual({ kind: 'unpublished' });
    expect(
      (await runUpgradeCheck(VERSION, NPM_PATH, { fetchDistTags: async () => ({ status: 'ok', tags: {} }) })).verdict,
    ).toEqual({ kind: 'unpublished' });
  });
  it('network：网络错分立（不与未发布混淆）', async () => {
    const check = await runUpgradeCheck(VERSION, NPM_PATH, {
      fetchDistTags: async () => ({ status: 'network', message: 'fetch failed' }),
    });
    expect(check.verdict).toEqual({ kind: 'network' });
    expect(check.remote).toEqual({ status: 'network', message: 'fetch failed' });
  });
});

describe('upgradeMain（#8 编排器行为面——注入假面锁：白名单/五态/退出码/npm 半态）', () => {
  /** npm 全局装路径假面（含 node_modules 段 → npm 形态 + npm 管理器） */
  const NPM_PATH = '/usr/local/lib/node_modules/berryagent/dist/app/main.js';
  /** 输出记录假面工厂（out/errs 数组 + 直写闭包） */
  const recordOutput = (): {
    out: string[];
    errs: string[];
    writeOut: (s: string) => void;
    writeErr: (s: string) => void;
  } => {
    const out: string[] = [];
    const errs: string[] = [];
    return { out, errs, writeOut: (s: string) => void out.push(s), writeErr: (s: string) => void errs.push(s) };
  };
  const okTags = (latest: string): { fetchDistTags: () => Promise<DistTagsResult> } => ({
    fetchDistTags: async () => ({ status: 'ok', tags: { latest } }),
  });

  it('安全线（白名单腿）：build 元数据形态过 semver 比对但拒 spawn——零调用 + 退 1 + stderr 形状非法', async () => {
    // '9.9.9+evil' 经 parseSemver 合法（+build 段被容忍）→ available → 进 spawn
    // 前撞白名单（白名单正则不容 + 段——npm i -g berryagent@9.9.9+evil 是坏靶）
    let spawned = 0;
    const { errs, writeOut, writeErr } = recordOutput();
    const code = await upgradeMain({
      entryRealPath: () => NPM_PATH,
      ...okTags('9.9.9+evil'),
      spawnNpm: async () => {
        spawned += 1;
        return 0;
      },
      out: writeOut,
      err: writeErr,
    });
    expect(code).toBe(1);
    expect(spawned).toBe(0); // 白名单在 spawn 前——唯一安全线不可绕
    expect(errs.join('')).toContain('形状非法');
    expect(errs.join('')).toContain('9.9.9+evil');
  });

  it('安全线（比对腿）：shell 元字符形态过不了 semver 比对——坍缩 up-to-date 退 0，spawn 同样零触达', async () => {
    // '1.0.0; rm -rf /tmp' 被 parseSemver（锚定正则）拒 → 按 0.0.0 兜底 → 本地
    // 版本恒 ≥ → up-to-date——两层防线：比对层先拦（元字符形态），白名单层兜
    // 比对可过的形态（build 元数据/空白）。任一层丢失，另一层独扛。
    let spawned = 0;
    const { out, writeOut, writeErr } = recordOutput();
    const code = await upgradeMain({
      entryRealPath: () => NPM_PATH,
      ...okTags('1.0.0; rm -rf /tmp'),
      spawnNpm: async () => {
        spawned += 1;
        return 0;
      },
      out: writeOut,
      err: writeErr,
    });
    expect(code).toBe(0);
    expect(spawned).toBe(0);
    expect(out.join('')).toContain('已是最新');
  });

  it('未发布态：退 0 + 诚实告知', async () => {
    const { out, writeOut, writeErr } = recordOutput();
    const code = await upgradeMain({
      entryRealPath: () => NPM_PATH,
      fetchDistTags: async () => ({ status: 'unpublished' }),
      out: writeOut,
      err: writeErr,
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain('尚未发布');
  });

  it('网络失败：退 1（唯一非 0 的检查类态）+ 不影响使用注记', async () => {
    const { out, writeOut, writeErr } = recordOutput();
    const code = await upgradeMain({
      entryRealPath: () => NPM_PATH,
      fetchDistTags: async () => ({ status: 'network', message: 'boom' }),
      out: writeOut,
      err: writeErr,
    });
    expect(code).toBe(1);
    expect(out.join('')).toContain('网络检查失败');
    expect(out.join('')).toContain('boom');
  });

  it('源码形态：退 0 + 四步指引 + 不自动执行', async () => {
    const { out, writeOut, writeErr } = recordOutput();
    const code = await upgradeMain({
      entryRealPath: () => '/repo/berry/dist/app/main.js',
      ...okTags('9.9.9'),
      out: writeOut,
      err: writeErr,
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain('git pull');
    expect(out.join('')).toContain('不自动执行');
  });

  it('已是最新：退 0 + spawn 零调用', async () => {
    let spawned = 0;
    const { out, writeOut, writeErr } = recordOutput();
    const code = await upgradeMain({
      entryRealPath: () => NPM_PATH,
      ...okTags(VERSION),
      spawnNpm: async () => {
        spawned += 1;
        return 0;
      },
      out: writeOut,
      err: writeErr,
    });
    expect(code).toBe(0);
    expect(spawned).toBe(0);
    expect(out.join('')).toContain('已是最新');
  });

  it('可升级：spawn 收 target → 成功退 0 + 重启提示', async () => {
    const targets: string[] = [];
    const { out, writeOut, writeErr } = recordOutput();
    const code = await upgradeMain({
      entryRealPath: () => NPM_PATH,
      ...okTags('9.9.9'),
      spawnNpm: async (target) => {
        targets.push(target);
        return 0;
      },
      out: writeOut,
      err: writeErr,
    });
    expect(code).toBe(0);
    expect(targets).toEqual(['9.9.9']);
    expect(out.join('')).toContain('升级完成');
    expect(out.join('')).toContain('重启');
  });

  it('npm 半态：退出码非 0 → 退 1 + 「包未变动，可重试」', async () => {
    const { errs, writeOut, writeErr } = recordOutput();
    const code = await upgradeMain({
      entryRealPath: () => NPM_PATH,
      ...okTags('9.9.9'),
      spawnNpm: async () => 1,
      out: writeOut,
      err: writeErr,
    });
    expect(code).toBe(1);
    expect(errs.join('')).toContain('包未变动');
    expect(errs.join('')).toContain('可重试');
  });
});
