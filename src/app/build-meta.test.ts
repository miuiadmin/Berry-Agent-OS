/**
 * dist 构建元数据回归锁（成熟度扫描 20260901 P1-13）：readBuildMeta 形状面 +
 * warnIfStaleDist 三前置矩阵（write/run 双注入面直调——warnUnknownAppEnvVars
 * 同款先例）。核心不变式：**任一前置失败零输出零抛**（dev 便利件永不 brick
 * 启动）+ 陈旧时恰一行含双方短哈希的 stderr warn。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readBuildMeta, warnIfStaleDist } from './build-meta.js';

/** 每测自建临时目录（afterAll 统一清——本套用例逐测建，收集进此数组） */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 造一个 dev 仓形态的临时包根：dist/.build-meta.json + .git 目录 + 返回入口 URL */
function makeDistPackage(meta: { commit: string | null } | null): { pkgRoot: string; selfUrl: string } {
  const pkgRoot = mkdtempSync(join(tmpdir(), 'berry-build-meta-'));
  roots.push(pkgRoot);
  mkdirSync(join(pkgRoot, 'dist'), { recursive: true });
  mkdirSync(join(pkgRoot, '.git'), { recursive: true });
  if (meta) writeFileSync(join(pkgRoot, 'dist', '.build-meta.json'), JSON.stringify(meta));
  return { pkgRoot, selfUrl: pathToFileURL(join(pkgRoot, 'dist', 'app', 'main.js')).href };
}

/** 40 位十六进制哈希工厂（a/b 两形供两侧比对） */
const sha = (c: string): string => c.repeat(40);

/** 收集 write 调用的记录器 + 假 git 探针工厂（双 describe 共用——B-2 归一面同款） */
const makeHarness = (git: (args: string[]) => string | undefined) => {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => lines.push(line),
    run: (args: string[]) => git(args),
  };
};

describe('readBuildMeta（形状面——缺席/坏档皆 null 不抛）', () => {
  it('合法档：commit 字符串读出', () => {
    const { pkgRoot } = makeDistPackage({ commit: sha('a') });
    expect(readBuildMeta(join(pkgRoot, 'dist'))).toEqual({ commit: sha('a') });
  });

  it('commit null 档：读出 null 位（git 缺席 build 的合法形态）', () => {
    const { pkgRoot } = makeDistPackage({ commit: null });
    expect(readBuildMeta(join(pkgRoot, 'dist'))).toEqual({ commit: null });
  });

  it('档缺席 / 坏 JSON / 形状不符（非哈希串）：皆 null', () => {
    const { pkgRoot } = makeDistPackage(null);
    expect(readBuildMeta(join(pkgRoot, 'dist'))).toBeNull();
    writeFileSync(join(pkgRoot, 'dist', '.build-meta.json'), '{oops');
    expect(readBuildMeta(join(pkgRoot, 'dist'))).toBeNull();
    writeFileSync(join(pkgRoot, 'dist', '.build-meta.json'), JSON.stringify({ commit: '123' }));
    expect(readBuildMeta(join(pkgRoot, 'dist'))).toBeNull();
  });
});

describe('warnIfStaleDist（三前置矩阵——write/run 双注入直调）', () => {
  it('前置①不过：src 直跑形态（无 /dist/app/ 段）零输出零探针', () => {
    const h = makeHarness(() => {
      throw new Error('不应触达 git 探针');
    });
    warnIfStaleDist(pathToFileURL('/tmp/x/src/app/main.ts').href, h);
    expect(h.lines).toEqual([]);
  });

  it('前置②不过：包根无 .git（node_modules 装机形态）零输出零探针', () => {
    const { pkgRoot, selfUrl } = makeDistPackage({ commit: sha('a') });
    rmSync(join(pkgRoot, '.git'), { recursive: true, force: true });
    const h = makeHarness(() => {
      throw new Error('不应触达 git 探针');
    });
    warnIfStaleDist(selfUrl, h);
    expect(h.lines).toEqual([]);
  });

  it('元数据缺席 / commit null：零输出（无从对照）', () => {
    const absent = makeDistPackage(null);
    const h1 = makeHarness(() => undefined);
    warnIfStaleDist(absent.selfUrl, h1);
    expect(h1.lines).toEqual([]);
    const nullCommit = makeDistPackage({ commit: null });
    const h2 = makeHarness(() => {
      throw new Error('不应触达 git 探针');
    });
    warnIfStaleDist(nullCommit.selfUrl, h2);
    expect(h2.lines).toEqual([]);
  });

  it('前置③不过：toplevel ≠ 包根（装进他人仓子目录形态）零输出', () => {
    const { pkgRoot, selfUrl } = makeDistPackage({ commit: sha('a') });
    const h = makeHarness((args) => (args[1] === '--show-toplevel' ? '/elsewhere/repo' : sha('b')));
    warnIfStaleDist(selfUrl, h);
    expect(h.lines).toEqual([]);
    expect(pkgRoot).toBeTruthy(); // 布局存在性自证（防树造空假绿）
  });

  it('探针失败（git 缺席形）：零输出零抛', () => {
    const { selfUrl } = makeDistPackage({ commit: sha('a') });
    const h = makeHarness(() => undefined);
    expect(() => warnIfStaleDist(selfUrl, h)).not.toThrow();
    expect(h.lines).toEqual([]);
  });

  it('新鲜形态（HEAD === build-meta）：零输出', () => {
    const { pkgRoot, selfUrl } = makeDistPackage({ commit: sha('a') });
    const h = makeHarness((args) => (args[1] === '--show-toplevel' ? pkgRoot : sha('a')));
    warnIfStaleDist(selfUrl, h);
    expect(h.lines).toEqual([]);
  });

  it('陈旧形态：恰一行 warn，含双方短哈希与重跑指路', () => {
    const { pkgRoot, selfUrl } = makeDistPackage({ commit: sha('a') });
    const h = makeHarness((args) => (args[1] === '--show-toplevel' ? pkgRoot : sha('b')));
    warnIfStaleDist(selfUrl, h);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('dist 产物落后于源码');
    expect(h.lines[0]).toContain(sha('a').slice(0, 8));
    expect(h.lines[0]).toContain(sha('b').slice(0, 8));
    expect(h.lines[0]).toContain('npm run build');
  });
});

describe('warnIfStaleDist 分隔符归一（全面复盘 20260902 B-2——win32 形状全链）', () => {
  /** win32 形状仿真 URL：真包根的 dist/app/main.js 路径段间分隔符换 %5C（反斜杠
   *  的 URL 编码形）——fileURLToPath 解码回反斜杠路径（win32 原生输出同族形状；
   *  macOS runner 上可真实走通整条告警链。首斜杠须保留字面——file: URL 的
   *  路径位才起头，落主机位会被 fileURLToPath 拒掉）。 */
  const winUrlOf = (pkgRoot: string): string => {
    const segs = join(pkgRoot, 'dist', 'app', 'main.js').split('/');
    return `file:///${segs.slice(1).join('%5C')}`;
  };

  it('win32 反斜杠路径：前置①照常命中——陈旧形态照常一行 warn（修前必红：探针恒不中零输出，win32 永不触发）', () => {
    const { pkgRoot } = makeDistPackage({ commit: sha('a') });
    const h = makeHarness((args) => (args[1] === '--show-toplevel' ? pkgRoot : sha('b')));
    warnIfStaleDist(winUrlOf(pkgRoot), h);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('dist 产物落后于源码');
  });

  it('win32 形状新鲜态（HEAD === build-meta）：零输出——归一不误伤新鲜判', () => {
    const { pkgRoot } = makeDistPackage({ commit: sha('a') });
    const h = makeHarness((args) => (args[1] === '--show-toplevel' ? pkgRoot : sha('a')));
    warnIfStaleDist(winUrlOf(pkgRoot), h);
    expect(h.lines).toEqual([]);
  });

  it('win32 形状 src 直跑（无 dist/app 段）：零输出零探针——归一不虚开告警面', () => {
    const h = makeHarness(() => {
      throw new Error('不应触达 git 探针');
    });
    warnIfStaleDist(`file:///C:%5Cwork%5Csrc%5Capp%5Cmain.ts`, h);
    expect(h.lines).toEqual([]);
  });
});
