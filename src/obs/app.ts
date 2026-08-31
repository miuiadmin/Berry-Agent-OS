/**
 * L3 obs — 官方件 `builtin:obs` 本体（契约篇 §6.9 刀一，2026-08-31 观测复盘批；
 * 默认层第十五行，Ring 2 真·可卸）。
 *
 * 刀一 = 摄取 + 聚合 + 查询面：
 * - **摄取**：订阅 session/event 总线信封（hostReserved 目录词——官方全局行
 *   名位是结构前提）→ 聚合器纯内存增量 → flushMs/flushBatch 批量落 rollup.db；
 * - **查询面两路**：模型工具 `obs_query`（四表聚合查询）+ TUI 命令 `/obs
 *   [tools|usage|turns|approvals]`（今日速览）；
 * - **停摄取纪律**（契约篇 §6.9）：自管库写失败 → 停摄取 + error 留痕
 *   （/obs-rebuild 判据触发面）。
 *
 * 刀二占位：`obs/alert` 词汇声明（emit）+ alerts 空表（store 私有迁移链）——
 * 执法落码随刀二。
 *
 * 拓扑窄边（web/admin 单边形态 + persist 自管库边）：tools/channels/paths/ui
 * 四服务全经 ctx.get（宿主装配序无条件 provide——fork 级联可见），零跨模块
 * import；typebox 走 contracts 再导出面。
 */

import { join } from 'node:path';
import type { AppContext, BuiltinAppModule } from '../contracts/app.js';
import type { CommandDefinition } from '../contracts/channels.js';
import { AppError, TOOL_ARGUMENTS_INVALID } from '../contracts/errors.js';
import { Type } from '../contracts/typebox.js';
import type { AgentToolResult, ToolDefinition, ToolsService } from '../contracts/tools.js';
import { createAggregator, type EventEnvelope } from './rollup.js';
import { openRollupStore, renderRollupTable, type RollupStore } from './store.js';
import type { RollupTable } from './rollup.js';

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
}

/** flush 缺省参数（5s / 256 条——契约篇 §6.9 刀一） */
const DEFAULT_FLUSH_MS = 5_000;
const DEFAULT_FLUSH_BATCH = 256;

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

/** 组装 obs_query 工具 def（查询面模型路——admin 只读工具族同构） */
function createObsQueryTool(store: RollupStore): ToolDefinition {
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
      return { content: [{ type: 'text', text: renderRollupTable(metric, rows) }] };
    },
  };
}

/** 今日窗口（本地时区零点 → 现在——/obs 命令族的人读口径） */
function localDayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** /obs 命令族的视图渲染（args 子视图分发） */
function renderObsView(store: RollupStore, view: string): string {
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
    // 刀二占位：告警触发词汇（订阅方可先行接线；执法落码随刀二）
    events: [{ name: 'obs/alert', mode: 'emit', note: '观测告警触发面（刀二执法落码；刀一词汇占位）' }],
    // 行 config（flush 两参 = 测试缝 + 运营旋钮——schema 校验装载期执法）
    config: Type.Object({
      flushMs: Type.Optional(Type.Number({ minimum: 50, description: '落账批量窗口毫秒（缺省 5000）' })),
      flushBatch: Type.Optional(Type.Number({ minimum: 1, description: '落账批量条数（缺省 256）' })),
    }),
    apply: (ctx: AppContext): void => {
      const tools = ctx.get<ToolsService>('tools');
      const channels = ctx.get<ChannelsFace>('channels');
      const paths = ctx.get<PathsFace>('paths');
      const ui = ctx.get<UiFace>('ui');
      const config = ctx.config as { flushMs?: unknown; flushBatch?: unknown };
      const flushMs = typeof config.flushMs === 'number' ? config.flushMs : DEFAULT_FLUSH_MS;
      const flushBatch = typeof config.flushBatch === 'number' ? config.flushBatch : DEFAULT_FLUSH_BATCH;

      // 自管库（rollup.db——私有迁移链 + 0600；开库失败 = 行失败响亮）
      const store = openRollupStore(join(paths.appDataDir(ctx.rowId ?? 'obs'), 'rollup.db'));
      const aggregator = createAggregator();
      let pendingCount = 0;
      let stopped = false;
      let unsubscribe: (() => void) | undefined;

      /** 落账一批（drain → 单事务 upsert）；失败 = 停摄取纪律（契约篇 §6.9） */
      const flush = (): void => {
        if (stopped || pendingCount === 0) return;
        pendingCount = 0;
        const deltas = aggregator.drain();
        try {
          store.apply(deltas);
        } catch (err) {
          stopped = true;
          unsubscribe?.();
          clearInterval(timer);
          ctx.logger.error('obs 自管库写失败——停摄取（/obs-rebuild 判据触发面，契约篇 §6.9 摄取纪律）', {
            error: err instanceof Error ? err.stack : String(err),
          });
        }
      };
      const timer = setInterval(flush, flushMs);
      timer.unref?.(); // 不持事件循环（TUI/run 入口自由退出——观测不反噬宿主）

      // 总线信封收窄（宿主派发形态 { sessionId, event }——防御性形状校验）
      const ingestEnvelope = (payload: unknown): void => {
        if (stopped || typeof payload !== 'object' || payload === null) return;
        const { sessionId, event } = payload as { sessionId?: unknown; event?: unknown };
        if (typeof sessionId !== 'string' || typeof event !== 'object' || event === null) return;
        aggregator.ingest(payload as EventEnvelope);
        pendingCount += 1;
        if (pendingCount >= flushBatch) flush();
      };

      // 注册即 effect：订阅 / 工具 / 命令随行作用域 LIFO 回卷（/reload 重装重开库）
      ctx.effect(() => {
        unsubscribe = ctx.on('session/event', ingestEnvelope);
        ctx.effect(() => tools.register(createObsQueryTool(store)));
        ctx.effect(() =>
          channels.registerCommand({
            name: 'obs',
            description: '观测面今日速览（/obs [tools|usage|turns|approvals]）',
            argumentHint: '[tools|usage|turns|approvals]',
            source: 'app',
            handler: (args: string): void => {
              ui.notify(renderObsView(store, args.trim()));
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
