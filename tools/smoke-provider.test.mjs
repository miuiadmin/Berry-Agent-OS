/**
 * 冒烟代理 provider 共享层回归锁（基建大扫 #34）：
 * smoke-real / smoke-carrier 的 provider 构造从两处逐字样板收编为单点后，
 * 此处锁构造面形态——provider id / 单模型目录透传 / Bearer 认证形 / 交互
 * 登录拒绝 / 缺参用法退出码。共享层被静默改形（漂移回两处或认证形变化）
 * 先在此红，不必等真模型炮（CI 无 key 跑不了）。
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PROXY_PROVIDER_ID, buildProxyProvider, readProxyEnv } from './smoke-provider.mjs';

/** 共享层脚本绝对路径（子进程 import 用——探针自身不依赖 cwd） */
const MODULE_URL = new URL('./smoke-provider.mjs', import.meta.url).href;

describe('冒烟代理 provider 共享层（基建大扫 #34）', () => {
  it('构造面形态：provider id + 单模型目录透传（modelId/baseUrl/api）', async () => {
    const provider = buildProxyProvider({ baseUrl: 'http://proxy.test', token: 'sk-fake', modelId: 'probe-model' });
    expect(provider.id).toBe(PROXY_PROVIDER_ID);
    const models = await provider.getModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'probe-model',
      provider: PROXY_PROVIDER_ID,
      baseUrl: 'http://proxy.test',
      api: 'anthropic-messages',
    });
  });

  it('认证形：resolve 返回 Bearer 头 + env 来源标注；login 恒拒（冒烟无交互面）', async () => {
    const provider = buildProxyProvider({ baseUrl: 'http://proxy.test', token: 'sk-fake-token', modelId: 'm' });
    const resolved = await provider.auth.apiKey.resolve();
    expect(resolved.source).toBe('ANTHROPIC_AUTH_TOKEN');
    expect(resolved.auth?.headers?.Authorization).toBe('Bearer sk-fake-token');
    await expect(provider.auth.apiKey.login()).rejects.toThrow(/不支持交互登录/);
  });

  it('readProxyEnv：env 约定直读（注入假值读出 + finally 还原，不碰真凭证）', () => {
    const savedUrl = process.env['ANTHROPIC_BASE_URL'];
    const savedToken = process.env['ANTHROPIC_AUTH_TOKEN'];
    try {
      process.env['ANTHROPIC_BASE_URL'] = 'http://env.test';
      process.env['ANTHROPIC_AUTH_TOKEN'] = 'sk-env-fake';
      expect(readProxyEnv()).toEqual({ baseUrl: 'http://env.test', token: 'sk-env-fake' });
    } finally {
      // 还原（vitest 同文件共享 process.env——不把假值漏给后续测试）
      if (savedUrl === undefined) delete process.env['ANTHROPIC_BASE_URL'];
      else process.env['ANTHROPIC_BASE_URL'] = savedUrl;
      if (savedToken === undefined) delete process.env['ANTHROPIC_AUTH_TOKEN'];
      else process.env['ANTHROPIC_AUTH_TOKEN'] = savedToken;
    }
  });

  it('requireProxyEnv 缺参用法退出（exit 2 + 用法行）——子进程真跑（process.exit 语义不被拦截）', async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { requireProxyEnv } from '${MODULE_URL}'; requireProxyEnv('usage-probe.mjs [模型id]');`,
      ],
      // 两 env 同空才触发缺参腿（任一在场即通过——与两炮原 if 判空同源）
      { env: { ...process.env, ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '' } },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).toBe(2);
    expect(stderr).toContain('usage-probe.mjs [模型id]');
    expect(stderr).toContain('ANTHROPIC_BASE_URL');
  });

  it('requireProxyEnv 齐参透传：返回 { baseUrl, token } 原值（调用方免再判空契约）', async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { requireProxyEnv } from '${MODULE_URL}'; console.log(JSON.stringify(requireProxyEnv('u')));`,
      ],
      { env: { ...process.env, ANTHROPIC_BASE_URL: 'http://ok.test', ANTHROPIC_AUTH_TOKEN: 'sk-ok-fake' } },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ baseUrl: 'http://ok.test', token: 'sk-ok-fake' });
  });
});
