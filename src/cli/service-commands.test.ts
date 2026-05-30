import { describe, expect, it, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServiceEnv, applyServiceEnvToCurrentProcess } from './service-commands.js';
import { getAppHome, getSocketPath, setAppHome } from '../utils/paths.js';

describe('service start options', () => {
  const savedHome = process.env.BERRY_HOME;
  const savedSocket = process.env.BERRY_SOCKET_PATH;
  const savedMode = process.env.BERRY_LLM_MODE;

  afterEach(() => {
    restoreEnv('BERRY_HOME', savedHome);
    restoreEnv('BERRY_SOCKET_PATH', savedSocket);
    restoreEnv('BERRY_LLM_MODE', savedMode);
    setAppHome(savedHome ?? join(tmpdir(), 'berryagent-test-home-reset'));
  });

  it('测试模式默认使用 mock LLM 和临时数据目录', () => {
    process.env.BERRY_HOME = '/existing/home';

    const env = buildServiceEnv({ test: true });

    expect(env.BERRY_LLM_MODE).toBe('mock');
    expect(env.BERRY_HOME).toContain('berry-test-');
  });

  it('显式 data-dir 和 socket 会应用到当前前台进程', () => {
    const home = join(tmpdir(), 'berry-cli-home');
    const socket = join(tmpdir(), 'berry-cli.sock');
    const env = buildServiceEnv({ test: true, dataDir: home, socket });

    applyServiceEnvToCurrentProcess(env);

    expect(getAppHome()).toBe(home);
    expect(getSocketPath()).toBe(socket);
    expect(process.env.BERRY_LLM_MODE).toBe('mock');
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
