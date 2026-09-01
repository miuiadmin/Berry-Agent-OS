/**
 * L1 context — 自写轻量 logger（技术栈篇 §6，第九批拍板 #16：pino 退役）。
 *
 * 职责收窄为「启动 / 崩溃 / 守门 / 恢复」的进程日志：结构化 JSON 行、写 stderr、
 * time/level/module/msg + 上下文字段。durable 审计走会话事件日志、实时推送走活体流，
 * 二者不经过本 logger。
 *
 * 纪律红线（技术栈篇 §6）：只在 debug 出现的分支，其行为必须同时是 durable 事件
 * 或运行时断言——「看不见的 bug」不允许靠进程日志独扛。
 *
 * 阈值盒模型（2026-09-01 基建大扫 #2/#4）：阈值不存 logger 自身闭包，存共享可变盒
 * { value }——同盒树（默认层全体 / 命中同一 env 条目的模块子树）的 logger 持同一
 * 盒引用，setLevel 改盒值即全树即时生效。child 不入登记表：旧 children 登记表
 * 只增不减 = daemon 热路径 scope.fork 派生的 child 永不注销的慢性泄漏；改盒后
 * child 持父盒引用，弃用后 GC 自然回收（WeakRef 探针回归锁钉扎，#2）。
 */

/** 日志级别（silent 用于整体关闭，如测试与工具进程） */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/** 级别权重：数值越大越啰嗦；阈值过滤规则 = weight(level) > weight(threshold) 时丢弃 */
const LEVEL_WEIGHT: Record<LogLevel, number> = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 };

/** 上下文附加字段（任意 JSON 可序列化键值） */
export type LogFields = Record<string, unknown>;

/**
 * 阈值盒：logger 树共享的可变阈值容器。同盒 = 同调级命运——setLevel 改盒值，
 * 持该盒的全体 logger（自身 + 派生 child + 同 env 条目命中的其他 logger）即时
 * 生效，无需级联遍历（旧 children 登记表方案废除，基建大扫 #2）。
 */
export interface ThresholdBox {
  /** 当前阈值（同盒全体实时读——write 过滤时取值，非创建时快照） */
  value: LogLevel;
}

/** logger 接口（ctx.logger 的类型；应用拿到的是带自身前缀的 child） */
export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** 派生带前缀的子 logger（前缀以 ':' 级联，如 root → 'session' → 'session:flush'）。
   *  盒沿树传递：child 的完整模块名命中 env override 条目时持该条目盒，否则持父盒
   *  ——同盒即同调级命运，父 setLevel 后随之；弃用后 GC 自然回收（不入登记表）。 */
  child(prefix: string): Logger;
  /** 调整本 logger 所在盒——同盒树全体即时生效（进程日志的调级面；durable/活体两层
   *  不受影响）。显式传 level 构造的 logger 持独立盒：调级只达自身及其派生。 */
  setLevel(level: LogLevel): void;
}

/** 级别配置解析结果：全局档盒 + per-module 条目盒池 */
interface LevelConfig {
  /** 全局档盒：env 无 override 命中的 logger 全体共享（root 树默认层） */
  globalBox: ThresholdBox;
  /** per-module 条目盒池（插入序即匹配优先序；同条目命中的 logger 共享同一盒） */
  boxes: Map<string, ThresholdBox>;
}

/** 有效级别闭集（警告文案用——与无效值警告 #5 同族同串） */
const VALID_LEVELS = 'error/warn/info/debug/silent';

/**
 * 解析 APP_LOG_LEVEL 逗号分模块语法（技术栈篇 §6「按模块调级语法」，2026-09-01
 * 第五十七批落地形态）：
 * - 形态一：纯级别串（"debug"）= 全局档——与历史行为一致；
 * - 形态二：逗号条目，"module:level" 按 lastIndexOf(':') 切分（模块名自身含冒号
 *   的嵌套前缀如 "context:app:debug" 可表达）；纯级别条目出现在任何位置都刷新
 *   全局档（后见胜——"info,session:debug,debug" 全局终值 debug）。
 * 无效条目不静默（与 #5 同原则）：stderr 一行警告后跳过该条目，不连坐其他条目
 * 与全局档；空条目（尾逗号/连续逗号）无害静默跳过。bootstrapping 阶段 logger
 * 尚未定级，警告直写 stderr。
 */
function parseLevelConfig(raw: string): LevelConfig {
  const boxes = new Map<string, ThresholdBox>();
  /** 全局档（无任何有效纯级别条目时保持平台缺省 info） */
  let globalValue: LogLevel = 'info';
  for (const tokenRaw of raw.split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const idx = token.lastIndexOf(':');
    if (idx === -1) {
      // 纯级别条目：全局档（任何位置都认，后见胜）
      if (token in LEVEL_WEIGHT) globalValue = token as LogLevel;
      else process.stderr.write(`[logger] APP_LOG_LEVEL="${token}" 不是有效级别（${VALID_LEVELS}），已跳过\n`);
      continue;
    }
    const mod = token.slice(0, idx);
    const lvl = token.slice(idx + 1);
    if (!mod || !(lvl in LEVEL_WEIGHT)) {
      // "session:"（级别空）或 ":debug"（模块名空）或级别拼错——条目级警告跳过
      process.stderr.write(
        `[logger] APP_LOG_LEVEL 条目 "${token}" 形如 module:level 但模块名为空或级别无效（${VALID_LEVELS}），已跳过\n`,
      );
      continue;
    }
    boxes.set(mod, { value: lvl as LogLevel });
  }
  return { globalBox: { value: globalValue }, boxes };
}

/** env 解析缓存（按原串缓存）：env 中途变化的测试形态自动失效重解析；同串期间
 *  child() 热路径只查 Map 不重复解析切分。进程级单例是盒池语义的前提——每次
 *  新建盒则「同条目命中者同盒」破裂（setLevel 不互通）。 */
let levelCache: { raw: string | undefined; config: LevelConfig } | null = null;

/** 取当前 env 的级别配置（无 env 时等价 "info"：全局 info 空条目池） */
function levelConfig(): LevelConfig {
  const raw = process.env['APP_LOG_LEVEL'];
  if (!levelCache || levelCache.raw !== raw) {
    levelCache = { raw, config: parseLevelConfig(raw ?? 'info') };
  }
  return levelCache.config;
}

/** env override 盒匹配：module === key 或前缀级联命中（'session' 条目命中
 *  'session' 与 'session:flush'）。多条目命中取先见——条目顺序即优先序
 *  （精确档写在前可覆盖宽档，如 "session:flush:info,session:debug"）。 */
function matchModuleBox(module: string): ThresholdBox | undefined {
  for (const [key, box] of levelConfig().boxes) {
    if (module === key || module.startsWith(key + ':')) return box;
  }
  return undefined;
}

/** 单行输出目标（默认 stderr；测试注入内存 sink 用） */
export type LogSink = (line: string) => void;

/**
 * 创建一个 logger。
 * @param opts.module 模块前缀（如 'session' / 'context:app:memory'）
 * @param opts.level  显式初始阈值 = 独立盒（不与树共享，env override 亦不生效——
 *                    测试注入语义：同文件内多 logger 互不串扰）
 * @param opts.sink   输出行目标，缺省 process.stderr
 * @param opts.box    内部接线位（child() 传父盒/命中盒用；外部勿传）
 */
export function createLogger(
  opts: { module?: string; level?: LogLevel; sink?: LogSink; box?: ThresholdBox } = {},
): Logger {
  const module = opts.module ?? 'app';
  const sink = opts.sink ?? ((line) => process.stderr.write(line + '\n'));
  // 盒决定序：内部接线盒 > 显式 level 独立盒 > env override 命中盒 > 全局档盒
  //（child 的 override 判定在 child() 内做——命中时传命中盒进来，此处自然最优先）
  const box: ThresholdBox =
    opts.box ??
    (opts.level !== undefined ? { value: opts.level } : (matchModuleBox(module) ?? levelConfig().globalBox));

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    // 盒值实时读：同盒任何成员 setLevel 后，本 logger 的过滤立即随之
    if (LEVEL_WEIGHT[level]! > LEVEL_WEIGHT[box.value]!) return;
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
      // child 盒判定：完整模块名（前缀级联后）命中 env override → 持命中盒；
      // 否则持父盒（同盒 = 父调级随之；无登记表，弃用后 GC 自然回收——#2）
      const full = `${module}:${prefix}`;
      return createLogger({ module: full, sink, box: matchModuleBox(full) ?? box });
    },
    setLevel: (level) => {
      box.value = level;
    },
  };
}
