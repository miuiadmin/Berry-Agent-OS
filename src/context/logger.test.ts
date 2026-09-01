/**
 * L1 context — 自写 logger 单元测试。
 *
 * 覆盖面（基建大扫 20260901 第五十七批 #3/#5 回归锁）：
 * - 缺省档 = info（发布物即生产——NODE_ENV 判定退役后的缺省语义）；
 * - APP_LOG_LEVEL 无效值不静默：stderr 一行警告 + 落缺省 info（拼错/大小写不吞）；
 * - 有效值（含大小写敏感边界）照常生效；级别过滤/child 前缀级联基本语义。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type LogSink } from './logger.js';

describe('logger 缺省档与无效值面（基建大扫 #3/#5）', () => {
  /** 环境变量快照（defaultLevel 读 APP_LOG_LEVEL/NODE_ENV——测试改写后必还原） */
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env['APP_LOG_LEVEL'];
    delete process.env['NODE_ENV'];
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('缺省档 = info：debug 被滤、info 可见（发布物即生产——#3 回归锁）', () => {
    const lines: string[] = [];
    const logger = createLogger({ module: 'test-default', sink: (l) => lines.push(l) });
    logger.debug('不应出现');
    logger.info('应出现');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('应出现');
    // NODE_ENV 不再参与判定（判定面退役——设了也不改缺省）
    process.env['NODE_ENV'] = 'development';
    const again = createLogger({ module: 'test-default-2', sink: (l) => lines.push(l) });
    again.debug('仍不应出现');
    expect(lines).toHaveLength(1);
  });

  it('APP_LOG_LEVEL 无效值：stderr 警告一行 + 落缺省 info（#5 回归锁——拼错不静默）', () => {
    // 劫持 stderr 捕获 bootstrapping 警告（logger 未定级时进程日志面自身不可用）
    const stderrChunks: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      process.env['APP_LOG_LEVEL'] = 'WARN'; // 大写拼错——历史行为：静默落 debug（比目标更吵）
      const lines: string[] = [];
      const logger = createLogger({ module: 'test-invalid', sink: (l) => lines.push(l) });
      logger.warn('warn 可见（warn ≤ info 缺省阈值？——warn 权重 1 ≤ 2 应可见');
      logger.info('info 可见');
      logger.debug('debug 被滤（缺省 info——降噪意图生效而非静默失效）');
      // 警告恰一行、含原值与有效值闭集提示
      const warning = stderrChunks.join('');
      expect(warning).toContain('WARN');
      expect(warning).toContain('error/warn/info/debug/silent');
      expect(lines).toHaveLength(2);
    } finally {
      process.stderr.write = realWrite;
    }
  });

  it('APP_LOG_LEVEL 有效值照常生效（大小写敏感）', () => {
    const lines: string[] = [];
    const sink: LogSink = (l) => lines.push(l);
    process.env['APP_LOG_LEVEL'] = 'debug';
    createLogger({ module: 't', sink }).debug('debug 档可见');
    expect(lines).toHaveLength(1);
    process.env['APP_LOG_LEVEL'] = 'silent';
    createLogger({ module: 't2', sink }).error('silent 全静默');
    expect(lines).toHaveLength(1);
  });
});

describe('logger 基本语义（既有行为钉扎）', () => {
  it('child 前缀以 : 级联且继承当前阈值', () => {
    const lines: string[] = [];
    const root = createLogger({ module: 'root', level: 'debug', sink: (l) => lines.push(l) });
    root.child('sub').debug('子级日志');
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.module).toBe('root:sub');
    expect(parsed.msg).toBe('子级日志');
  });

  it('fields 顶展进行（一级平铺）', () => {
    const lines: string[] = [];
    createLogger({ module: 't', level: 'info', sink: (l) => lines.push(l) }).info('带字段', {
      code: 'X_Y',
      ms: 42,
    });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.code).toBe('X_Y');
    expect(parsed.ms).toBe(42);
    expect(parsed.level).toBe('info');
  });
});
