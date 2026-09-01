/**
 * L1 context — 自写 logger 单元测试。
 *
 * 覆盖面（基建大扫 20260901 第五十七批 #3/#5/#2/#4 回归锁）：
 * - 缺省档 = info（发布物即生产——NODE_ENV 判定退役后的缺省语义）；
 * - APP_LOG_LEVEL 无效值不静默：stderr 一行警告 + 落缺省 info（拼错/大小写不吞）；
 * - 有效值（含大小写敏感边界）照常生效；级别过滤/child 前缀级联基本语义；
 * - 阈值盒模型（#2）：长寿 parent 下 child 弃用后 GC 可回收（登记表已废）；
 * - 逗号分模块调级语法（#4）：`info,session:debug` 分档 / 前缀级联命中 / 嵌套
 *   模块名 / 无效条目警告跳过 / per-module setLevel 只达该模块子树。
 */

import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type LogLevel, type LogSink } from './logger.js';

/** 造一个捕获输出的 logger（每断言独立 lines，避免 sink 串台） */
function capture(module: string, level?: LogLevel) {
  const lines: string[] = [];
  const sink: LogSink = (l) => lines.push(l);
  return { logger: createLogger({ module, level, sink }), lines };
}

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

describe('logger 阈值盒与 GC 回收（基建大扫 #2）', () => {
  /** 环境变量快照（本组测试改 APP_LOG_LEVEL 触发盒池重解析，改写后必还原） */
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env['APP_LOG_LEVEL'] = 'info'; // 显式 raw 隔离本组的盒池缓存条目
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('child 弃用后 GC 可回收：长寿 parent 下零登记表强引用（#2 回归锁——子进程探针）', async () => {
    // 泄漏真场景 = 长寿 parent（模拟 rootLogger 常驻 daemon）：旧 children 登记表
    // 只增不减，child 弃用后仍被登记表强引用永不回收；共享盒模型下 child 只持
    // 盒引用（child→box 单向），GC 自然回收。探针必须 spawn 子进程真跑 GC：
    // - vitest 主进程无 --expose-gc；
    // - node v24 栈保守扫描（CSS）会把同步栈上的残留指针当活引用（三基线全
    //   ALIVE 假阳性实证）——探针内 setTimeout 换到干净栈后再 gc 断言。
    // 探针码用动态 import 形态（import 后跟变量参数）而非静态 from-字符串形态：
    // 后者的码面文本会被 check-topology 的 importSpecifiers 正则当真导入吞掉
    // （模板串里的说明符占位被捕获成裸导入/相对导入违规）——动态参数非字面量
    // 不命中任何一条提取正则，门禁与探针两安。
    const modUrl = JSON.stringify(new URL('./logger.ts', import.meta.url).href);
    const code = `
const { createLogger } = await import(${modUrl});
const parent = createLogger({ module: 'leak-probe', sink: () => {} });
const ref = await (async () => new WeakRef(parent.child('gone')))();
await new Promise((r) => setTimeout(r, 20));
gc(); gc();
process.exit(ref.deref() === undefined ? 0 : 1);
`;
    const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', code], {
      stdio: 'ignore',
    });
    const exit = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(exit).toBe(0); // 1 = child 被某处强引用（登记表回潮/新增反向引用）
  }, 20_000);

  it('默认层同盒：无 override 命中的 logger 全体共享全局档盒——一方调级全体随之', () => {
    const a = capture('mod-a');
    const b = capture('mod-b');
    a.logger.debug('调级前滤（全局 info）');
    expect(a.lines).toHaveLength(0);
    a.logger.setLevel('debug');
    // b 与 a 同持全局档盒（规范「默认层全体」语义）——a 调级后 b 的过滤立即随之
    b.logger.debug('同盒随之可见');
    expect(b.lines).toHaveLength(1);
    a.logger.setLevel('info'); // 复位（盒随缓存对象持活，不污染后续同 raw 消费者）
  });

  it('显式 level = 独立盒：调级不外溢（测试注入语义）', () => {
    const a = capture('iso-a', 'debug');
    const b = capture('iso-b', 'info');
    a.logger.setLevel('silent');
    b.logger.info('独立盒不受邻位调级影响');
    expect(b.lines).toHaveLength(1);
  });
});

describe('APP_LOG_LEVEL 逗号分模块语法（基建大扫 #4）', () => {
  /** 环境变量快照（逗号条目驱动盒池；改写后必还原） */
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('形态二分档：`info,session:debug` = 全局 info + session 子树 debug', () => {
    process.env['APP_LOG_LEVEL'] = 'info,session:debug';
    const s = capture('session');
    const t = capture('tools');
    s.logger.debug('session debug 可见');
    t.logger.debug('tools debug 滤');
    t.logger.info('tools info 可见');
    expect(s.lines).toHaveLength(1);
    expect(t.lines).toHaveLength(1);
    expect(JSON.parse(t.lines[0]!).msg).toBe('tools info 可见');
  });

  it('前缀级联命中：`session` 条目覆盖 child 派生（session:flush 完整名命中）', () => {
    process.env['APP_LOG_LEVEL'] = 'info,session:debug';
    const flush = capture('session:flush');
    flush.logger.debug('child 完整模块名命中 session 条目');
    expect(flush.lines).toHaveLength(1);
  });

  it('嵌套模块名：`context:app:debug` 按 lastIndexOf 切分——context:app 命中、context 不命中', () => {
    process.env['APP_LOG_LEVEL'] = 'info,context:app:debug';
    const hit = capture('context:app');
    hit.logger.debug('嵌套命中可见');
    expect(hit.lines).toHaveLength(1);
    const miss = capture('context');
    miss.logger.debug('父前缀不命中（无级联回退）');
    expect(miss.lines).toHaveLength(0);
  });

  it('无效条目不静默：stderr 警告 + 跳过该条目（全局档不受连坐）', () => {
    const stderrChunks: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      process.env['APP_LOG_LEVEL'] = 'info,session:verbose';
      const s = capture('session');
      s.logger.debug('bogus 条目跳过 → session 落全局档 info，debug 滤');
      expect(s.lines).toHaveLength(0);
      const warning = stderrChunks.join('');
      expect(warning).toContain('session:verbose');
      expect(warning).toContain('error/warn/info/debug/silent');
    } finally {
      process.stderr.write = realWrite;
    }
  });

  it('per-module setLevel 只达该模块子树：session 调级 flush child 随之（同盒），tools 不动', () => {
    process.env['APP_LOG_LEVEL'] = 'info,session:debug';
    const s = capture('session');
    const flushLines: string[] = [];
    const flush = createLogger({
      module: 'session',
      sink: (l) => flushLines.push(l),
    }).child('flush');
    const t = capture('tools');
    s.logger.setLevel('info');
    flush.debug('同盒：session 调级后 flush 随之滤');
    flush.info('同盒：info 仍可见');
    t.logger.info('tools 不受 session 盒调级影响');
    expect(flushLines.filter((l) => l.includes('随之滤'))).toHaveLength(0);
    expect(flushLines.filter((l) => l.includes('仍可见'))).toHaveLength(1);
    expect(t.lines).toHaveLength(1);
  });

  it('同条目命中者同盒：两个 session logger（盒池不重建盒）setLevel 互通', () => {
    process.env['APP_LOG_LEVEL'] = 'info,session:debug';
    const a = capture('session');
    const b = capture('session'); // 第二个直建 logger——命中同一 env 条目 → 同一盒对象
    // 盒值是进程级运行态（前测可能已调级）——显式定锚，断言只锁「a 调级达 b」
    a.logger.setLevel('debug');
    b.logger.debug('同盒：a 定锚 debug 后随之可见');
    expect(b.lines).toHaveLength(1);
    a.logger.setLevel('silent');
    b.logger.error('同盒调级后 error 也滤（silent 全静默）');
    expect(b.lines).toHaveLength(1);
  });
});
