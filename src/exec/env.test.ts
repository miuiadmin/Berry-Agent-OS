/**
 * L4 exec 单元测试 — 子进程环境白名单（契约篇 §1.2 E 组执法面②）。
 *
 * 纯函数测试（buildChildEnv 注入式宿主环境）：白名单透传 / deny-by-default /
 * inherit 禁运两响亮拒 / set 任意名 / unset / 大小写不敏感。
 */

import { describe, expect, it } from 'vitest';
import { AppError, EXEC_ENV_FORBIDDEN } from '../contracts/errors.js';
import { buildChildEnv, isEnvNameForbidden } from './env.js';

/** 合成一个典型宿主环境（白名单内若干 + 白名单外若干 + 禁运若干） */
const FAKE_HOST_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/op',
  LANG: 'en_US.UTF-8',
  LC_CTYPE: 'UTF-8',
  TERM: 'xterm-256color',
  // 白名单外：deny-by-default 不透传
  NPM_CONFIG_REGISTRY: 'https://registry.example',
  COLORFGBG: '15;0',
  // 禁运两：凭证族 + 宿主保留前缀
  MY_SERVICE_API_KEY: 'sk-secret',
  ANTHROPIC_BASE_URL: 'https://proxy.example',
} as NodeJS.ProcessEnv;

describe('白名单隐式透传（deny-by-default）', () => {
  it('只透传白名单名——白名单外宿主变量不出现在子进程', () => {
    const child = buildChildEnv(FAKE_HOST_ENV);
    expect(child.PATH).toBe('/usr/bin:/bin');
    expect(child.HOME).toBe('/home/op');
    expect(child.LC_CTYPE).toBe('UTF-8'); // LC_ 前缀族
    expect(child.NPM_CONFIG_REGISTRY).toBeUndefined();
    expect(child.COLORFGBG).toBeUndefined();
  });
  it('纯白名单下禁运名也不透传（即使宿主环境里有）', () => {
    const child = buildChildEnv(FAKE_HOST_ENV);
    expect(child.MY_SERVICE_API_KEY).toBeUndefined();
    expect(child.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

describe('inherit 声明追加', () => {
  it('inherit 白名单外的正常名可显式追加（值取宿主）', () => {
    const child = buildChildEnv(FAKE_HOST_ENV, { inherit: ['NPM_CONFIG_REGISTRY'] });
    expect(child.NPM_CONFIG_REGISTRY).toBe('https://registry.example');
  });
  it('inherit 命中凭证族后缀 = EXEC_ENV_FORBIDDEN 响亮拒', () => {
    expect(() => buildChildEnv(FAKE_HOST_ENV, { inherit: ['MY_SERVICE_API_KEY'] })).toThrowError(AppError);
    try {
      buildChildEnv(FAKE_HOST_ENV, { inherit: ['MY_SERVICE_API_KEY'] });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(EXEC_ENV_FORBIDDEN);
    }
  });
  it('inherit 命中宿主保留前缀 = EXEC_ENV_FORBIDDEN（大小写不敏感）', () => {
    expect(() => buildChildEnv(FAKE_HOST_ENV, { inherit: ['ANTHROPIC_BASE_URL'] })).toThrowError(/ANTHROPIC/);
    expect(() => buildChildEnv(FAKE_HOST_ENV, { inherit: ['openai_org'] })).toThrowError(/openai/);
    expect(() => buildChildEnv(FAKE_HOST_ENV, { inherit: ['APP_DATA_DIR'] })).toThrowError(/APP_DATA_DIR/);
  });
  it('inherit 宿主没有的名字 = 跳过不造空值', () => {
    const child = buildChildEnv(FAKE_HOST_ENV, { inherit: ['NOT_PRESENT'] });
    expect(child.NOT_PRESENT).toBeUndefined();
  });
});

describe('set / unset 显式变更', () => {
  it('set 任意名合法（含禁运形名——值来源纪律归调用方，机器不猜）', () => {
    const child = buildChildEnv(FAKE_HOST_ENV, { set: { CI: '1', MY_TOOL: 'value' } });
    expect(child.CI).toBe('1');
    expect(child.MY_TOOL).toBe('value');
  });
  it('set 覆盖白名单透传值；unset 撤白名单名', () => {
    const child = buildChildEnv(FAKE_HOST_ENV, { set: { LANG: 'C' }, unset: ['TERM'] });
    expect(child.LANG).toBe('C');
    expect(child.TERM).toBeUndefined();
  });
});

describe('禁运判定（大小写不敏感）', () => {
  it('凭证族后缀与宿主保留前缀的大小写变形全命中', () => {
    expect(isEnvNameForbidden('GITHUB_TOKEN')).toBe(true);
    expect(isEnvNameForbidden('github_token')).toBe(true);
    expect(isEnvNameForbidden('DB_PASSWORD')).toBe(true);
    expect(isEnvNameForbidden('OAUTH_ACCESS_TOKEN')).toBe(true);
    expect(isEnvNameForbidden('SESSION_SECRET')).toBe(true);
    expect(isEnvNameForbidden('ANTHROPIC_API_KEY')).toBe(true);
    expect(isEnvNameForbidden('anthropic_auth_token')).toBe(true);
    expect(isEnvNameForbidden('APP_DB_PATH')).toBe(true);
  });
  it('正常名不误伤', () => {
    expect(isEnvNameForbidden('PATH')).toBe(false);
    expect(isEnvNameForbidden('GIT_EDITOR')).toBe(false);
    expect(isEnvNameForbidden('TOKENIZER_PARALLELISM')).toBe(false); // TOKEN 只是子串不是后缀
  });
});
