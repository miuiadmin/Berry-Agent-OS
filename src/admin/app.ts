/**
 * L4 admin — 官方件 `builtin:admin`（契约篇 §3.4 平台管理面，2026-08-27 刀 1+
 * 刀 3，默认层第十行，Ring 2 真·可卸）。
 *
 * 刀 1 = 只读面两工具（「禁注册无身动词」——既有服务面的文本化呈现，不造第二
 * 数据源）：
 * - `apps_list`：装载态一览（ctx.apps.list + 组合树行 source 推导）；
 * - `events_query`：跨会话 durable 事件有界查询（ctx.sessions.queryEvents——
 *   会话篇 §3.4 单原语的工具层壳：ISO 8601 转毫秒、data 摘要截断、flushFirst
 *   恒置 true）。
 *
 * 刀 3 = 写类动词六词导线（契约篇 §3.4 刀 2 工具族与 Skill 兑现条）：五写词
 * （install/update/toggle/configure/reload——生命周期档审批对恒经人手，机制
 * 形态见 ./write-tools.ts 模块头）+ `apps_uninstall_inspect`（read——双相
 * 卸载的模型面，执行权在人）。服务面导线同批：configure/requestReload 落
 * src/app/apps.ts（本件只消费不实现）。
 *
 * 管理操作知识 = 同件携带 Skill `./skills/admin`（§4.1 纯知识注入——它教
 * 方法，动词住工具）。builtin 件无入口文件路径，包根以 packageRoot 自述
 * （import.meta.url 位置事实——契约篇 §3.4 两处钉死，仅 builtin 行生效）。
 *
 * 拓扑最小边（mcp/web 同款窄边）：全部依赖经 ctx.get 运行时服务面取
 * （tools/sessions/apps/approval 四键都是宿主装配序无条件 provide 的服务，
 * approval 在 ⑥ 审批段早于 ⑨ 应用装载——fork 级联可见），零跨模块 import
 * ——服务面的结构子集类型在本文件与 write-tools.ts 本地收窄。
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, TOOL_ARGUMENTS_INVALID } from '../contracts/errors.js';
import type { EventQueryCursor, EventQueryOptions, EventQueryResult } from '../contracts/events.js';
import type { AgentToolResult, ToolDefinition, ToolsService } from '../contracts/tools.js';
import type { BuiltinAppModule, AppContext } from '../contracts/app.js';
import { Type } from '../contracts/typebox.js';
import {
  createAppsConfigureTool,
  createAppsInstallTool,
  createAppsMountTool,
  createAppsReloadTool,
  createAppsToggleTool,
  createAppsUnmountTool,
  createAppsUninstallInspectTool,
  createAppsUpdateTool,
  type ApprovalAskFace,
  type AppsManageFace,
} from './write-tools.js';

/**
 * ctx.apps.list() 单行的结构子集（admin 件消费面收窄——宿主实现类型在 app
 * 模块，应用结构上不可 import；服务经 ctx.get 运行时取，形状由宿主装配保证）。
 * source 字段 = list 时从组合树 plan 行现推导的行来源（本批新增）。
 */
export interface AppRowView {
  readonly id: string;
  readonly status: string;
  readonly name?: string;
  readonly code?: string;
  readonly message?: string;
  readonly reason?: string;
  readonly applyMs?: number;
  readonly source?: string;
}

/** ctx.apps 服务面的结构子集（清单只读面） */
export interface AppsListFace {
  /** 装载状态清单（组合树行序；装载前视角的行 = planned 兜底） */
  list(): ReadonlyArray<AppRowView>;
}

/** ctx.sessions 服务面的结构子集（queryEvents——会话篇 §3.4 单原语） */
export interface SessionsQueryFace {
  /** 跨会话有界时间窗查询（组合根闭包实现：persist:false 降级返空） */
  queryEvents(opts: EventQueryOptions): Promise<EventQueryResult>;
}

/** 模型面单事件 data 摘要的呈现截断（~300 字符——服务面原样不截断，截断归本层） */
const DATA_SUMMARY_LIMIT = 300;

/** 单事件 data 的摘要形态：JSON 序列化 + 超限截断标注（全文长度一并披露） */
function summarizeData(data: unknown): string {
  const text = JSON.stringify(data) ?? 'null';
  return text.length > DATA_SUMMARY_LIMIT
    ? `${text.slice(0, DATA_SUMMARY_LIMIT)}…（已截断，全文 ${text.length} 字符）`
    : text;
}

/** 纯文本结果（AgentToolResult 的薄构造——本件两工具均纯文本呈现） */
function textResult(text: string): AgentToolResult {
  return { content: [{ type: 'text', text }] };
}

/** 单行装载态的模型面呈现（/apps 命令人读版同源数据、各自格式化） */
function formatStatusRow(row: AppRowView): string {
  const source = row.source ?? '来源未知';
  switch (row.status) {
    case 'activated':
      return `✓ ${row.id}（${source}${row.name !== undefined ? ` · ${row.name}` : ''}${
        row.applyMs !== undefined ? ` · apply ${row.applyMs}ms` : ''
      }）`;
    case 'failed':
      return `✖ ${row.id}（${source}）：${row.code ?? '?'} ${row.message ?? ''}`.trimEnd();
    case 'skipped':
      return `· ${row.id}（${source}）跳过：${row.reason ?? '?'}`;
    default:
      // planned = 装载前视角；unresolved 行恒在此呈现（无装载结果可覆盖）
      return `○ ${row.id}（${source}）planned——尚未装载（unresolved/装载未收口均此形态）`;
  }
}

/**
 * 构造 `apps_list` 工具定义（无参只读——装载态一览）。
 * 「禁注册无身动词」执法样例：本工具是对 ctx.apps.list() 的文本化呈现，
 * 不造第二数据源（清单唯一事实源 = 组合树，§1.5）。
 */
export function createAppsListTool(apps: AppsListFace): ToolDefinition {
  return {
    name: 'apps_list',
    description:
      '列出应用装载态清单：组合树每行的状态（activated/failed/skipped/planned）、来源（builtin/npm/git/local）、失败原因与 apply 耗时。无参数。',
    parameters: Type.Object({}),
    effect: 'read',
    async execute(): Promise<AgentToolResult> {
      const rows = apps.list();
      if (rows.length === 0) {
        return textResult('组合树无应用行（默认层为空）——装载态清单为空。');
      }
      const activated = rows.filter((r) => r.status === 'activated').length;
      const failed = rows.filter((r) => r.status === 'failed').length;
      const skipped = rows.filter((r) => r.status === 'skipped').length;
      const lines = rows.map(formatStatusRow);
      return textResult(
        [
          `应用装载态（共 ${rows.length} 行：activated ${activated} · failed ${failed} · skipped ${skipped}）：`,
          ...lines,
        ].join('\n'),
      );
    },
  };
}

/** ISO 8601 → 毫秒 epoch（模型面时间用 ISO 字符串——毫秒数模型易写错，转换归本层） */
function parseIsoMs(key: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(String(value));
  if (Number.isNaN(ms)) {
    throw new AppError(
      TOOL_ARGUMENTS_INVALID,
      `${key} 不是合法 ISO 8601 时间：${String(value)}（例：2026-08-27T09:00:00Z）`,
    );
  }
  return ms;
}

/** cursor 参数的形状校验（三键齐备才有效——坏形状响亮拒绝不静默忽略） */
function parseCursor(value: unknown): EventQueryCursor | undefined {
  if (value === undefined) return undefined;
  const c = value as { time?: unknown; sessionId?: unknown; seq?: unknown };
  if (typeof c.time !== 'number' || typeof c.sessionId !== 'string' || typeof c.seq !== 'number') {
    throw new AppError(
      TOOL_ARGUMENTS_INVALID,
      `cursor 形状非法（须 { time: number, sessionId: string, seq: number }——把上一页输出的 nextCursor 原样回传，不要手造）`,
    );
  }
  return { time: c.time, sessionId: c.sessionId, seq: c.seq };
}

/**
 * 构造 `events_query` 工具定义（跨会话 durable 事件有界查询——最新在前分页）。
 * 服务层迟滞披露的模型面收口：flushFirst 不入参数、本层恒置 true（模型面
 * 管理/审计场景低频、精确性优先，免模型懂 write-behind 屏障概念——冷读 B1）。
 */
export function createEventsQueryTool(sessions: SessionsQueryFace): ToolDefinition {
  return {
    name: 'events_query',
    description:
      '跨会话查询 durable 事件日志（唯一事实源的直接读，非投影）：按时间窗（ISO 8601，含端点）/事件类型/应用域/单会话过滤，最新在前、组合游标分页。types 是数据条件——查已卸载应用留下的旧词汇返回空不报错。',
    parameters: Type.Object({
      since: Type.Optional(Type.String({ description: '时间窗下界（ISO 8601，含端点；缺省无下界）' })),
      until: Type.Optional(Type.String({ description: '时间窗上界（ISO 8601，含端点；缺省无上界）' })),
      types: Type.Optional(
        Type.Array(Type.String(), { description: '事件类型过滤维（如 ["user/message","llm/usage"]）' }),
      ),
      app: Type.Optional(Type.String({ description: '应用域过滤（sessions.app 列；如 "chat"）' })),
      sessionId: Type.Optional(Type.String({ description: '单会话细查（退化用法）' })),
      limit: Type.Optional(Type.Integer({ description: '页大小（缺省 200、硬帽 1000）' })),
      cursor: Type.Optional(
        Type.Object(
          {
            time: Type.Integer({ description: '游标行时间（毫秒）' }),
            sessionId: Type.String({ description: '游标行会话 id' }),
            seq: Type.Integer({ description: '游标行序号' }),
          },
          { description: '分页游标——上一页 nextCursor 原样回传（向更旧翻页）' },
        ),
      ),
    }),
    effect: 'read',
    // 签名对齐 ToolDefinition.execute(args, ctx)——首参即参数面（ctx 携带
    // toolCallId/signal，本工具不用；AgentTool 才是 (toolCallId, args) 形态）
    async execute(args: Record<string, unknown>): Promise<AgentToolResult> {
      const sinceMs = parseIsoMs('since', args.since);
      const untilMs = parseIsoMs('until', args.until);
      const cursor = parseCursor(args.cursor);
      const result = await sessions.queryEvents({
        ...(sinceMs !== undefined ? { sinceMs } : {}),
        ...(untilMs !== undefined ? { untilMs } : {}),
        ...(Array.isArray(args.types) ? { types: args.types.map((t) => String(t)) } : {}),
        ...(typeof args.app === 'string' ? { app: args.app } : {}),
        ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        flushFirst: true, // 恒置 true：模型面精确性优先（服务面缺省 false——参数语义见会话篇 §3.4）
      });
      const lines: string[] = [];
      if (result.rows.length === 0) {
        lines.push('无匹配事件（过滤条件均为含端点闭区间——放宽时间窗或核对 types/app/sessionId 拼写）。');
      } else {
        lines.push(`事件 ${result.rows.length} 行（最新在前）：`);
        for (const row of result.rows) {
          // 行格式：ISO 时间 · 会话 id 短前缀（8 位定位足够人读，全 id 在游标里）· 类型 · data 摘要
          lines.push(
            `${new Date(row.time).toISOString()}  ${row.sessionId.slice(0, 8)}  ${row.type}  ${summarizeData(row.data)}`,
          );
        }
      }
      if (result.nextCursor !== undefined) {
        lines.push(`（还有更旧事件——nextCursor 回传翻页：${JSON.stringify(result.nextCursor)}）`);
      }
      if (result.truncated) {
        lines.push('[truncated] 本页不是全部（limit 超硬帽已钳制到 1000，或仍有更旧页——见 nextCursor）。');
      }
      lines.push('[迟滞说明] 查询前已执行 flush 屏障——结果含最新事件（write-behind 尾部无迟滞）。');
      return textResult(lines.join('\n'));
    },
  };
}

/**
 * 构造 admin 官方件（builtins 注册表 `builtin:admin` 行）。
 * packageRoot 自述 = 本文件所在目录（import.meta.url 运行时求值的位置事实，
 * 结构上不可能漂——契约篇 §3.4 第一刀细化段两处钉死之二）。
 */
export function createAdminApp(): BuiltinAppModule {
  return {
    name: 'admin',
    // 硬依赖四键全为宿主装配序无条件 provide 的服务（tools 由 Ring 1 行独立锚
    // 先行装载；approval 在 ⑥ 审批段——写类动词的审批对面）——缺供即装配断言，
    // 诊断树也须见到此行
    inject: ['tools', 'sessions', 'apps', 'approval'],
    skills: ['./skills/admin'],
    packageRoot: dirname(fileURLToPath(import.meta.url)),
    apply: (ctx: AppContext): void => {
      const tools = ctx.get<ToolsService>('tools');
      // 刀 1 只读面：清单 + 事件查询（结构子集类型收窄见各 face 定义）
      const appsRead = ctx.get<AppsListFace>('apps');
      const sessions = ctx.get<SessionsQueryFace>('sessions');
      // 刀 3 写面：管理动词写词 + 卸载检视（审批对面 = 根审批服务——fork
      // 级联可见；asked/decided 双腿落 durable 由审批服务承载）；D2 两态批
      // （2026-08-27 第三十批）扩 mount/unmount 两写词——写行类模型可用
      const appsManage = ctx.get<AppsManageFace>('apps');
      const approval = ctx.get<ApprovalAskFace>('approval');
      // 注册即 effect：十工具挂行作用域，/reload 锚回卷或行失败连带回卷撤件
      ctx.effect(() => tools.register(createAppsListTool(appsRead)));
      ctx.effect(() => tools.register(createEventsQueryTool(sessions)));
      ctx.effect(() => tools.register(createAppsInstallTool(appsManage, approval)));
      ctx.effect(() => tools.register(createAppsMountTool(appsManage, approval)));
      ctx.effect(() => tools.register(createAppsUnmountTool(appsManage, approval)));
      ctx.effect(() => tools.register(createAppsUpdateTool(appsManage, approval)));
      ctx.effect(() => tools.register(createAppsToggleTool(appsManage, approval)));
      ctx.effect(() => tools.register(createAppsConfigureTool(appsManage, approval)));
      ctx.effect(() => tools.register(createAppsReloadTool(appsManage, approval)));
      ctx.effect(() => tools.register(createAppsUninstallInspectTool(appsManage)));
      ctx.logger.debug('admin 件十工具已注册（只读两件 + 写类七件〔含 mount/unmount〕 + 卸载检视一件）');
    },
  };
}
