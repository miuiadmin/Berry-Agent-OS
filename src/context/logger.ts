/**
 * L1 context — 自写轻量 logger（技术栈篇 §6，第九批拍板 #16：pino 退役）。
 *
 * 职责收窄为「启动 / 崩溃 / 守门 / 恢复」的进程日志：结构化 JSON 行、写 stderr、
 * time/level/module/msg + 上下文字段。durable 审计走会话事件日志、实时推送走活体流，
 * 二者不经过本 logger。
 *
 * 纪律红线（技术栈篇 §6）：只在 debug 出现的分支，其行为必须同时是 durable 事件
 * 或运行时断言——「看不见的 bug」不允许靠进程日志独扛。
 */

/** 日志级别（silent 用于整体关闭，如测试与工具进程） */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/** 级别权重：数值越大越啰嗦；阈值过滤规则 = weight(level) > weight(threshold) 时丢弃 */
const LEVEL_WEIGHT: Record<LogLevel, number> = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 };

/** 上下文附加字段（任意 JSON 可序列化键值） */
export type LogFields = Record<string, unknown>;

/** logger 接口（ctx.logger 的类型；应用拿到的是带自身前缀的 child） */
export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** 派生带前缀的子 logger（前缀以 ':' 级联，如 root → 'session' → 'session:flush'） */
  child(prefix: string): Logger;
  /** 运行时调整本 logger 阈值（进程日志的调级面；durable/活体两层不受影响） */
  setLevel(level: LogLevel): void;
}

/** 默认级别解析：APP_LOG_LEVEL 环境变量 > 生产 info / 开发 debug（技术栈篇 §6 拍板） */
function defaultLevel(): LogLevel {
  const fromEnv = process.env['APP_LOG_LEVEL'];
  if (fromEnv && fromEnv in LEVEL_WEIGHT) return fromEnv as LogLevel;
  return process.env['NODE_ENV'] === 'production' ? 'info' : 'debug';
}

/** 单行输出目标（默认 stderr；测试注入内存 sink 用） */
export type LogSink = (line: string) => void;

/**
 * 创建一个 logger。
 * @param opts.module 模块前缀（如 'session' / 'context:app:memory'）
 * @param opts.level  初始阈值，缺省走 defaultLevel()
 * @param opts.sink   输出行目标，缺省 process.stderr
 */
export function createLogger(opts: { module?: string; level?: LogLevel; sink?: LogSink } = {}): Logger {
  const module = opts.module ?? 'app';
  const sink = opts.sink ?? ((line) => process.stderr.write(line + '\n'));
  let threshold = opts.level ?? defaultLevel();
  /** 子 logger 登记表（setLevel 沿子树级联用；child 创建时登记，2026-08-23 独立重读轮 #23 落码） */
  const children: Logger[] = [];

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[level]! > LEVEL_WEIGHT[threshold]!) return;
    // 结构化 JSON 行：time/level/module/msg 平铺，fields 顶展（一级平铺够诊断用，不嵌套）
    const line = JSON.stringify({ time: new Date().toISOString(), level, module, msg: message, ...fields });
    sink(line);
  };

  return {
    error: (m, f) => write('error', m, f),
    warn: (m, f) => write('warn', m, f),
    info: (m, f) => write('info', m, f),
    debug: (m, f) => write('debug', m, f),
    child: (prefix) => {
      // 子 logger 继承创建时刻的阈值快照 + 登记进子树表（此后父 setLevel 会级联覆盖）
      const child = createLogger({ module: `${module}:${prefix}`, level: threshold, sink });
      children.push(child);
      return child;
    },
    setLevel: (level) => {
      threshold = level;
      // 沿子树级联：运行时调级必须达全部派生 logger——不级联则调级后应用日志
      // 仍按创建时的旧阈值过滤（技术栈篇拍板的运维调级面，应用 logger 必须随调）
      for (const child of children) child.setLevel(level);
    },
  };
}
