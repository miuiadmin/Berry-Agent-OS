/**
 * L3 obs — 官方件 `builtin:obs` 本体（契约篇 §6.9 刀一，2026-08-31 观测复盘批；
 * 默认层第十五行，Ring 2 真·可卸）。
 *
 * 刀一 = 摄取 + 聚合 + 查询面：
 * - **摄取**：订阅 session/event 总线信封（hostReserved 目录词——官方全局行
 *   名位是结构前提）→ 聚合器纯内存增量 → flushMs/flushBatch 批量落 rollup.db；
 * - **查询面两路**：模型工具 `obs_query`（四表聚合查询）+ TUI 命令 `/obs
 *   [tools|usage|turns|approvals]`（今日速览）；
 * - **停摄取纪律**（契约篇 §6.9）：自管库写失败 → 停摄取 + warn 留痕
 *   （/obs-rebuild 判据触发面）。
 *
 * 刀二（已落码）：告警面全量——规则表 CRUD + `/obs-alerts` 命令族 + rollup
 * 写入同事务内联执法（过阈 + 冷却窗外 → obs/alert emit + ui.notify +
 * last_fired_at 回写 + alerts.jsonl 留账〔P1-12〕）；红线：只通知不执法
 * （规则面不读不写宿主护栏参数）。
 *
 * 观测健康面（成熟度扫描 20260901 P1-11）：apply 期 provide `obs-health`
 * 函数面（ingesting/lastFlushAt 晚取）——宿主根读链经 tryGet 织入 webui
 * `/api/health` 载荷 `obs` 键与 daemon doctor ② 判读（停摄取服务面可见）。
 *
 * 拓扑窄边（web/admin 单边形态 + persist 自管库边）：tools/channels/paths/ui
 * 四服务全经 ctx.get（宿主装配序无条件 provide——fork 级联可见），零跨模块
 * import；typebox 走 contracts 再导出面。
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext, BuiltinAppModule } from '../contracts/app.js';
import type { CommandDefinition } from '../contracts/channels.js';
import { AppError, TOOL_ARGUMENTS_INVALID } from '../contracts/errors.js';
import { Type } from '../contracts/typebox.js';
import type { AgentToolResult, ToolDefinition, ToolsService } from '../contracts/tools.js';
import { createAggregator, type EventEnvelope } from './rollup.js';
import { openRollupStore, renderRollupTable, type AlertRule, type RollupStore } from './store.js';
import type { RollupTable } from './rollup.js';
import { OBS_EVENTS } from './events.js';

/** ctx.channels 服务面的结构子集（命令注册——宿主实现类型在 channels 模块） */
interface ChannelsFace {
  registerCommand(command: CommandDefinition): () => void;
}

/** ctx.paths 服务面的结构子集（数据目录正规口——双键机制全局行同适用） */
interface PathsFace {
  appDataDir(rowId: string): string;
}

/** ctx.ui 服务面的结构子集（命令呈现——notify 广播面） */
interface UiFace {
  notify(message: string): void;
  /**
   * 广播面在场探针（复盘 20260901 R-2，可选面——旧宿主缺省视为有观众）：
   * 告警触发四件整笔前置——探针假（无头进程）整笔跳过不耗冷却。
   */
  hasAudience?(): boolean;
}

/**
 * obs 观测健康面（P1-11——`obs-health` 服务的值形状）：**函数面晚取**——探测
 * 时刻读当前值（非 provide 时刻快照），webui /api/health `obs` 键与 daemon
 * doctor ② 判读经宿主根读链消费（tryGet 晚绑——行禁用/重装窗键缺席）。
 */
export interface ObsHealthFace {
  /** 摄取是否在跑（false = 停摄取纪律已触发——纯派生数据损失，非服务面危机） */
  ingesting(): boolean;
  /** 最近一次成功 flush 时刻（epoch 毫秒；未 flush 过 = undefined → JSON 键缺席） */
  lastFlushAt(): number | undefined;
}

/** flush 缺省参数（5s / 256 条——契约篇 §6.9 刀一） */
const DEFAULT_FLUSH_MS = 5_000;
const DEFAULT_FLUSH_BATCH = 256;

/**
 * alerts.jsonl 轮转帽（字节）——追写前检查，超帽代际归档 alerts.jsonl →
 * alerts.jsonl.1（单代留存；daemon.log 轮转同款机制与同值，遗漏大扫
 * 20260902-b #5）。「触发频率受冷却窗天然限流」的原假设被 cooldown_min=0
 * 合法档（schema 域 0..43200）击破——daemon 常驻 + 无冷却规则 + 持续过阈
 * ≈ 3.4MB/天无界累积（jobs 终态帽 L-4「daemon 常驻防无界累积」同族）。
 */
export const OBS_ALERTS_ROTATE_BYTES = 10 * 1024 * 1024;

/**
 * 留账追写前的代际轮转：账本超帽 → rename 为 alerts.jsonl.1（旧 .1 先删再
 * 换——POSIX rename 原子覆盖、Windows 撞存在目标报错故先清位，daemon.log
 * 同语义）。轮转失败不吞触发不阻追写（与留账失败同策略）：清位/归档两步
 * 失败经注入的 warn 面**当场留痕**（遗漏大扫 20260902-c #14——旧形注释宣称
 * 「rename 炸时调用方 catch 兜」是结构性死路：本函数就地吞错后外层 catch
 * 永不触发，规范承诺的 warn 诊断信号零出现、账本超帽无界膨胀无迹可查），
 * 追写原地续尾即回到无轮转语义，膨胀面交下次触发重试。
 */
function rotateAlertsIfNeeded(
  alertsPath: string,
  /** warn 留痕面（调用方注入 logger.warn——与留账失败 warn 同格式可归因「轮转」面） */
  warn: (message: string, fields: Record<string, unknown>) => void,
): void {
  let size: number;
  try {
    size = statSync(alertsPath).size;
  } catch {
    return; // 账本缺席（从未触发过）——无轮转面
  }
  if (size <= OBS_ALERTS_ROTATE_BYTES) return;
  const archived = `${alertsPath}.1`;
  try {
    rmSync(archived, { force: true }); // force：旧代缺席即 no-op
  } catch (err) {
    warn('obs 告警轮转清位失败（旧代 .1 删不动——归档 rename 大概率同败，追写原地续尾）', {
      alertsPath,
      error: err instanceof Error ? err.stack : String(err),
    });
  }
  try {
    renameSync(alertsPath, archived);
  } catch (err) {
    warn('obs 告警轮转归档失败（rename 炸——账本超帽续尾，膨胀面交下次触发重试）', {
      alertsPath,
      error: err instanceof Error ? err.stack : String(err),
    });
  }
}

/** obs_query 四表枚举（alerts 不是 metric——冷读 M1） */
const OBS_METRICS = ['llm', 'tool', 'turn', 'approval'] as const;

/** ISO 8601 → 毫秒（非法即抛——参数已过 schema，这里是语义校验） */
const parseIso = (value: string, field: string): number => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new AppError(TOOL_ARGUMENTS_INVALID, `${field} 不是合法 ISO 8601 时间：${value}`);
  }
  return ms;
};

/**
 * 停摄取披露条（基建大扫 #15——契约篇 §6.9）：flush 抛错停摄取后，三个消费面
 * （obs_query 回执尾行 / /obs 总览头部 / /obs-alerts list）同步标注停态与数据
 * 截至时刻——停态对消费面可见，不留「进程日志 warn 是唯一痕迹」的盲区。
 * lastFlushAt = 最近一次成功 flush 时刻（件内内存值；未 flush 过 = '(未落账)'）。
 */
const stoppedNoteText = (stopped: boolean, lastFlushAt: number | undefined): string | undefined =>
  stopped
    ? `⚠ 摄取已停——数据截至 ${lastFlushAt === undefined ? '(未落账)' : new Date(lastFlushAt).toISOString()}`
    : undefined;

/** 组装 obs_query 工具 def（查询面模型路——admin 只读工具族同构） */
function createObsQueryTool(store: RollupStore, stoppedNote: () => string | undefined): ToolDefinition {
  return {
    name: 'obs_query',
    description:
      '查询观测聚合（小时粒度 rollup）。metric 四表：llm（调用/重试/token 四桶，维度 app/model/priority）、' +
      'tool（调用/守门拦截/失败/超时/时长，维度 app/tool）、turn（轮次/消息/工具调用计数，维度 app）、' +
      'approval（审批五值桶，维度 app）。groupBy 可含 hour；空数组 = 窗口总计。',
    effect: 'read',
    parameters: Type.Object({
      metric: Type.Union(
        OBS_METRICS.map((m) => Type.Literal(m)),
        { description: '聚合表名' },
      ),
      from: Type.Optional(Type.String({ description: '起始时间 ISO 8601（缺省 = 24 小时前）' })),
      to: Type.Optional(Type.String({ description: '结束时间 ISO 8601（缺省 = 现在）' })),
      groupBy: Type.Optional(Type.Array(Type.String(), { description: '分组维度（随表维度 ∪ hour；空数组 = 总计）' })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: '行帽（缺省 50）' })),
    }),
    execute: async (args: Record<string, unknown>): Promise<AgentToolResult> => {
      const metric = args['metric'] as RollupTable;
      const to = typeof args['to'] === 'string' ? parseIso(args['to'], 'to') : Date.now();
      const from = typeof args['from'] === 'string' ? parseIso(args['from'], 'from') : to - 24 * 3_600_000;
      const groupBy = Array.isArray(args['groupBy']) ? (args['groupBy'] as string[]) : undefined;
      let rows;
      try {
        rows = store.query({
          metric,
          fromMs: from,
          toMs: to,
          ...(groupBy === undefined ? {} : { groupBy }),
          ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
        });
      } catch (err) {
        // groupBy 非法维度——语义错误按参数错误呈现（模型可修笔重试）
        throw new AppError(TOOL_ARGUMENTS_INVALID, err instanceof Error ? err.message : String(err));
      }
      // 停摄取披露（#15）：回执尾行标注——停态下查询结果只到 lastFlushAt
      const note = stoppedNote();
      return {
        content: [{ type: 'text', text: renderRollupTable(metric, rows) + (note === undefined ? '' : `\n${note}`) }],
      };
    },
  };
}

/** 今日窗口（本地时区零点 → 现在——/obs 命令族的人读口径） */
function localDayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** /obs 命令族的视图渲染（args 子视图分发；stoppedNote = 停摄取披露条 #15） */
function renderObsView(store: RollupStore, view: string, stoppedNote?: string): string {
  const from = localDayStart();
  const to = Date.now();
  const q = (metric: RollupTable, groupBy?: readonly string[]): string => {
    try {
      return renderRollupTable(
        metric,
        store.query({ metric, fromMs: from, toMs: to, ...(groupBy ? { groupBy } : {}) }),
      );
    } catch {
      return `（${metric} 查询失败——rollup 库可能已停摄取，见启动日志）`;
    }
  };
  switch (view) {
    case '':
    case 'overview': {
      // 总览四行（今日窗口、全维度总计）
      const summary = (metric: RollupTable): string => {
        const rows = store.query({ metric, fromMs: from, toMs: to, groupBy: [] });
        if (rows.length === 0) return '0';
        const m = rows[0]!.measures;
        if (metric === 'llm')
          return `${m['calls']} 次调用 / ${m['retries']} 次重试 / in ${m['tokens_in']} · out ${m['tokens_out']}`;
        if (metric === 'tool')
          return `${m['calls']} 次调用（拦截 ${m['blocked']} · 失败 ${m['failures']} · 超时 ${m['timeouts']}）`;
        if (metric === 'turn')
          return `${m['turns']} 轮（用户 ${m['user_msgs']} · 助手 ${m['assistant_msgs']} · 工具 ${m['tool_calls']}）`;
        return `asked ${m['asked']}（批准 ${m['approved']} · 拒绝 ${m['rejected']} · 取消 ${m['cancel']} · 不可用 ${m['unavailable']}）`;
      };
      return [
        '今日观测总览：',
        // 停摄取披露（#15）：总览头部标注——头排即见停态，不藏表尾
        ...(stoppedNote === undefined ? [] : [stoppedNote]),
        `  llm：${summary('llm')}`,
        `  工具：${summary('tool')}`,
        `  轮次：${summary('turn')}`,
        `  审批：${summary('approval')}`,
      ].join('\n');
    }
    case 'tools':
      return `今日工具聚合（按工具）：\n${q('tool', ['tool'])}`;
    case 'usage':
      return `今日模型用量（按模型）：\n${q('llm', ['model'])}`;
    case 'turns':
      return `今日轮次（按小时）：\n${q('turn', ['hour'])}`;
    case 'approvals':
      return `今日审批（按小时）：\n${q('approval', ['hour'])}`;
    default:
      return `未知视图「${view}」——/obs [tools|usage|turns|approvals]`;
  }
}

/**
 * /obs-alerts 命令族处理（契约篇 §6.9 刀二动词面——/tick 同款风格）。
 * 解析错与值域错统一抛错（命令壳兜底为通知——人与模型都可修笔重试）。
 */
function handleAlertsCommand(store: RollupStore, args: string, stoppedNote?: string): string {
  const parts = args.split(/\s+/).filter((token) => token !== '');
  const [verb, ...rest] = parts;
  switch (verb) {
    case undefined:
    case 'list': {
      const rules = store.listAlerts();
      if (rules.length === 0) {
        // 空表面同样带停摄取披露（#15）——停态先知，不留「有规则才见停态」的盲角
        return [
          '告警规则：（无）/obs-alerts add <sum|avg|max> <表.列> <op> <阈值> [窗h] [冷却min] 添加',
          ...(stoppedNote === undefined ? [] : [stoppedNote]),
        ].join('\n');
      }
      const header = 'id | metric | 聚合 阈值 | 窗h | 冷却min | 状态 | 上次触发';
      const lines = rules.map(
        (rule) =>
          `${rule.id} | ${rule.metric} | ${rule.agg} ${rule.op} ${rule.threshold} | ${rule.windowHours} | ${rule.cooldownMin} | ` +
          `${rule.enabled ? '启用' : '停用'} | ${rule.lastFiredAt === null ? '未触发' : new Date(rule.lastFiredAt).toISOString()}`,
      );
      return [
        '告警规则（只通知不执法——执法在宿主护栏）：',
        // 停摄取披露（#15）：list 头部标注——规则触发的度量源已停须先知
        ...(stoppedNote === undefined ? [] : [stoppedNote]),
        header,
        ...lines,
      ].join('\n');
    }
    case 'add': {
      const [agg, metric, op, threshold, windowHours, cooldownMin] = rest;
      if (agg === undefined || metric === undefined || op === undefined || threshold === undefined) {
        throw new Error('用法：/obs-alerts add <sum|avg|max> <表.列> <op> <阈值> [窗h=24] [冷却min=60]');
      }
      const rule = store.addAlert({
        metric,
        agg: agg as AlertRule['agg'],
        op: op as AlertRule['op'],
        threshold: Number(threshold),
        windowHours: windowHours === undefined ? 24 : Number(windowHours),
        cooldownMin: cooldownMin === undefined ? 60 : Number(cooldownMin),
      });
      return `已添加告警规则 [${rule.id}]：${rule.metric} ${rule.agg} ${rule.op} ${rule.threshold}（窗 ${rule.windowHours}h / 冷却 ${rule.cooldownMin}min）`;
    }
    case 'rm': {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) throw new Error('用法：/obs-alerts rm <id>');
      if (!store.removeAlert(id)) throw new Error(`规则 ${id} 不存在`);
      return `已删除告警规则 [${id}]`;
    }
    case 'enable':
    case 'disable': {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) throw new Error(`用法：/obs-alerts ${verb} <id>`);
      if (!store.setAlertEnabled(id, verb === 'enable')) throw new Error(`规则 ${id} 不存在`);
      return `规则 [${id}] 已${verb === 'enable' ? '启用' : '停用'}`;
    }
    default:
      throw new Error(`未知动词「${verb}」——list / add / rm / enable / disable`);
  }
}

/**
 * 创建 obs 官方件模块（builtins.ts 注册——零宿主资源闭包：数据库路径经
 * ctx.paths 正规口、四服务全 ctx.get，BuiltinRegistryOptions 零新字段）。
 */
export function createObsApp(): BuiltinAppModule {
  return {
    name: 'obs',
    // 四键全为宿主装配序无条件 provide 的服务（Ring 1 tools 先行装载；
    // channels/paths/ui 由 Ring 1 channels 行装载期 provide——本行居其后的
    // 默认层装载序，fork 级联可见）。缺供即装配断言，诊断树也须见到此行
    inject: ['tools', 'channels', 'paths', 'ui'],
    // 刀二：告警触发词汇（执法已落码——rollup 写入内联检查过阈即发）。
    // 声明抽出 events.ts 单源（第四十六批）：装载器读本字段登记、check-events
    // 声明层对照读同一 const——两消费方零漂移。
    events: OBS_EVENTS,
    // 行 config（flush 两参 = 测试缝 + 运营旋钮——schema 校验装载期执法）
    config: Type.Object({
      flushMs: Type.Optional(Type.Number({ minimum: 50, description: '落账批量窗口毫秒（缺省 5000）' })),
      flushBatch: Type.Optional(Type.Number({ minimum: 1, description: '落账批量条数（缺省 256）' })),
      busyTimeoutMs: Type.Optional(
        Type.Number({ minimum: 1, description: '自管库撞锁等待上限毫秒（缺省 5000——flushMs 同款旋钮，基建大扫 #17）' }),
      ),
    }),
    apply: (ctx: AppContext): void => {
      const tools = ctx.get<ToolsService>('tools');
      const channels = ctx.get<ChannelsFace>('channels');
      const paths = ctx.get<PathsFace>('paths');
      const ui = ctx.get<UiFace>('ui');
      const config = ctx.config as { flushMs?: unknown; flushBatch?: unknown; busyTimeoutMs?: unknown };
      const flushMs = typeof config.flushMs === 'number' ? config.flushMs : DEFAULT_FLUSH_MS;
      const flushBatch = typeof config.flushBatch === 'number' ? config.flushBatch : DEFAULT_FLUSH_BATCH;
      // busyTimeoutMs（#17）：撞锁等待降档旋钮——透传开库注入位（缺省 5000）

      // 自管库（rollup.db——私有迁移链 + 0600；开库失败 = 行失败响亮）；
      // 数据域目录提为具名常量：rollup.db 路径（停摄取 warn 处置文案指真实库
      // 文件——成熟度扫描快赢 #3）与 alerts.jsonl 留账路径（P1-12）同域两物
      const dataDir = paths.appDataDir(ctx.rowId ?? 'obs');
      const dbPath = join(dataDir, 'rollup.db');
      /** 告警留账账本（P1-12——与 rollup.db 同域）：盘上第一手触发记录，crash.log 同族诊断辅助件 */
      const alertsPath = join(dataDir, 'alerts.jsonl');
      const store = openRollupStore(dbPath, {
        busyTimeoutMs: typeof config.busyTimeoutMs === 'number' ? config.busyTimeoutMs : undefined,
      });
      const aggregator = createAggregator();
      let pendingCount = 0;
      let stopped = false;
      /**
       * 最近一次成功 flush 时刻（基建大扫 #15）：停摄取披露条「数据截至」的锚
       * （未 flush 过 = undefined → 披露 '(未落账)'）；内存值——重启归零即回
       * 未落账形态，与停态本就随进程走的语义一致
       */
      let lastFlushAt: number | undefined;
      let unsubscribe: (() => void) | undefined;

      /**
       * 告警触发四件（契约篇 §6.9 刀二——store 内联执法的回调侧）：①obs/alert 总线
       * 词汇（他应用可订阅联动）②ui.notify（到人性依赖 daemon 常驻——TUI 进程
       * 内形态只到前台）③last_fired_at 回写在 store 事务内（④之前完成——提交后
       * 出膛序，见下）④alerts.jsonl 留账追写（P1-12——一行 JSON：信封负载 +
       * firedAt + op）。红线：只通知不执法——本回调零宿主护栏读写。
       */
      const fireAlert = (fire: { rule: AlertRule; value: number }): void => {
        const { rule, value } = fire;
        // 异常隔离（刀二复盘补）：回调在 store 事务提交后出膛（遗漏大扫
        // 20260902 #1——修前在事务内，通知面抛错冒泡会回滚含 last_fired_at 的
        // 整笔触发）。出膛后事务已定，此层隔离的守备对象换成：①通知/留账异常
        // 不冒泡炸调用方（flush 编舞）②本条通知失败不吞后续 fired 条目——观测
        // 摄取的可用性仍高于单次通知送达，吞异常留痕（emit 自身 fireIsolated
        // 已隔离，此层兜 ui.notify 通道面）
        try {
          ctx.emit('obs/alert', {
            ruleId: rule.id,
            metric: rule.metric,
            agg: rule.agg,
            value,
            threshold: rule.threshold,
            windowHours: rule.windowHours,
          });
          ui.notify(
            `⚠ 观测告警 [${rule.id}] ${rule.metric}：${rule.agg} ${rule.windowHours}h = ${value}（${rule.op} ${rule.threshold}）`,
          );
        } catch (err) {
          ctx.logger.warn('obs 告警通知面异常（已隔离——不影响摄取与后续通知条目）', {
            ruleId: rule.id,
            error: err instanceof Error ? err.stack : String(err),
          });
        }
        // ④ 留账追写（P1-12）：独立隔离位——与通知面分立 try（warn 文案须能归因
        // 到「留账」面，测试断言据此判读）；机制同 crash-log.ts（同步小写 + 目录
        // 幂等建），失败策略异——写失败 warn 留痕不吞（观测路径非崩溃路径可承担
        // warn），异常不冒泡炸调用方（flush 编舞）、不触停摄取
        try {
          // 目录幂等建（首开防御——常态已由 paths.appDataDir 建好；不带 mode 位：
          // mkdir 的 mode 只作用于新建段，目录已在时是死位，且权限已由 0700 数据
          // 根罩住——遗漏大扫 20260902 U1 死位清理，防「权限已收紧」错觉）
          mkdirSync(dataDir, { recursive: true });
          // 追写前轮转检查（#5）：超帽代际归档 .1——旧代先删再换，轮转失败
          // warn 当场留痕（20260902-c #14）不阻追写（best-effort 同本块失败策略）
          rotateAlertsIfNeeded(alertsPath, (message, fields) => ctx.logger.warn(message, fields));
          appendFileSync(
            alertsPath,
            // firedAt = 触发时点 ISO；op 取自规则行（不在 obs/alert 信封里——信封
            // 消费方自带规则上下文，账本行是离线取证物须自含判据）
            `${JSON.stringify({
              ruleId: rule.id,
              metric: rule.metric,
              agg: rule.agg,
              value,
              threshold: rule.threshold,
              windowHours: rule.windowHours,
              firedAt: new Date().toISOString(),
              op: rule.op,
            })}\n`,
          );
        } catch (err) {
          ctx.logger.warn('obs 告警留账追写失败（best-effort——不影响触发与事务提交）', {
            alertsPath,
            ruleId: rule.id,
            error: err instanceof Error ? err.stack : String(err),
          });
        }
      };

      /** 落账一批（drain → 单事务 upsert + 内联告警执法）；失败 = 停摄取纪律（契约篇 §6.9） */
      const flush = (): void => {
        if (stopped || pendingCount === 0) return;
        pendingCount = 0;
        const deltas = aggregator.drain();
        try {
          // canFire = 观众探针前置（复盘 R-2）：无头进程（无 ui 后端）触发四件
          // 整笔跳过——不回写 last_fired_at、不 emit、不 notify、不追写留账
          // （探针缺省真——旧宿主形态视为有观众，行为不回退）
          store.apply(deltas, fireAlert, () => ui.hasAudience?.() ?? true);
          lastFlushAt = Date.now(); // #15：成功落账时刻——停摄取后「数据截至」的锚
        } catch (err) {
          stopped = true;
          unsubscribe?.();
          clearInterval(timer);
          ctx.logger.warn(
            // 处置指现存路径（快赢#3）：rollup.db 纯派生可整库删除重建（运维手册
            // §1 同源）——warn 直接给真实库路径，不再引用挂账未落码的 /obs-rebuild
            `obs 自管库写失败——停摄取。处置：删除 ${dbPath} 后 /reload 或重启重建（纯派生库——契约篇 §6.9 摄取纪律）`,
            {
              error: err instanceof Error ? err.stack : String(err),
            },
          );
        }
      };
      /** 停摄取披露条（#15）取值面：三消费面（工具回执 / /obs / /obs-alerts）共用 */
      const stoppedNote = (): string | undefined => stoppedNoteText(stopped, lastFlushAt);

      // 观测健康面（P1-11）：provide 函数面晚取——宿主根读链（根表→系统区表，
      // 本行属默认层 = 系统区表）经 tryGet 消费；/reload 重装时行作用域整体
      // 回卷、键随之消失（tryGet undefined = 键缺席语义天然正确，无需清槽配对）
      ctx.provide<ObsHealthFace>('obs-health', {
        ingesting: () => !stopped,
        lastFlushAt: () => lastFlushAt,
      });

      const timer = setInterval(flush, flushMs);
      timer.unref?.(); // 不持事件循环（TUI/run 入口自由退出——观测不反噬宿主）

      // 总线信封收窄（宿主派发形态 { sessionId, event }——防御性形状校验）
      const ingestEnvelope = (payload: unknown): void => {
        if (stopped || typeof payload !== 'object' || payload === null) return;
        const { sessionId, event } = payload as { sessionId?: unknown; event?: unknown };
        if (typeof sessionId !== 'string' || typeof event !== 'object' || event === null) return;
        // 畸形信封防御（复盘 20260901 批实测补）：time 非有限数值 = 发射方契约
        // 违规（NaN 小时桶经 better-sqlite3 绑定即 NULL → NOT NULL 约束炸库，
        // 会毒化整批 flush 并误触停摄取）——门口拦下：跳过 + warn，不毒批
        const { time } = event as { time?: unknown };
        if (typeof time !== 'number' || !Number.isFinite(time)) {
          ctx.logger.warn('obs 跳过畸形信封（time 非有限数值——发射方契约违规）', {
            sessionId,
            type: (event as { type?: unknown }).type,
          });
          return;
        }
        // 返回值 = 遮蔽回退落空条数（复盘 D-3）：重启/全量 reload 窗与 drain
        // 窗同族近似——非零即响亮留痕（「live=重建」不变式近似打破的信号）
        const misses = aggregator.ingest(payload as EventEnvelope);
        if (misses > 0) {
          ctx.logger.warn(
            // 同上快赢#3：不引用挂账命令，指现存重建路径（近似窗仅聚合漂移，删库重建即消）
            `obs 遮蔽回退落空 ${misses} 条（重启/reload/drain 近似窗——聚合漂移；可删 rollup.db 重建，纯派生库）`,
            {
              sessionId,
            },
          );
        }
        pendingCount += 1;
        if (pendingCount >= flushBatch) flush();
      };

      // 注册即 effect：订阅 / 工具 / 命令随行作用域 LIFO 回卷（/reload 重装重开库）
      ctx.effect(() => {
        unsubscribe = ctx.on('session/event', ingestEnvelope);
        ctx.effect(() => tools.register(createObsQueryTool(store, stoppedNote)));
        ctx.effect(() =>
          channels.registerCommand({
            name: 'obs',
            description: '观测面今日速览（/obs [tools|usage|turns|approvals]）',
            argumentHint: '[tools|usage|turns|approvals]',
            source: 'app',
            handler: (args: string): void => {
              ui.notify(renderObsView(store, args.trim(), stoppedNote()));
            },
          }),
        );
        ctx.effect(() =>
          channels.registerCommand({
            name: 'obs-alerts',
            description:
              '观测告警规则面（list / add <sum|avg|max> <表.列> <op> <阈值> [窗h] [冷却min] / rm <id> / enable|disable <id>）',
            argumentHint: 'list',
            source: 'app',
            handler: (args: string): void => {
              ui.notify(handleAlertsCommand(store, args.trim(), stoppedNote()));
            },
          }),
        );
        return () => {
          clearInterval(timer);
          if (!stopped) {
            try {
              flush(); // 回卷前尽力落账尾窗（≤flushMs 丢窗为规范既定，此处收窄）
            } catch {
              // 关停路静默（停摄取语义已在此前留痕或库已不可用）
            }
          }
          store.close();
        };
      });
    },
  };
}
