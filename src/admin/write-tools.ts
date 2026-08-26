/**
 * L4 admin — 管理件写类动词六工具（契约篇 §3.4 刀 2 工具族与 Skill 兑现条，
 * 2026-08-27 刀 3 落码；默认层 admin 行内注册，effect:'write' 五词 + read 一词）。
 *
 * 三档分级的落码形态：本文件五写词全走「生命周期档」——参数面强制审批对
 * （sandbox_permissions + justification 成对非空，schema 必填钉死）→ 值校验 →
 * approval.ask（asked/decided 双腿落 durable 由审批服务免费承载）→
 * allowed-once 才调服务面。**生命周期档复用 bash 升权闭包先例的四件套机制
 * （成对面纪律 / approval.ask / allowed-once / durable 落账）但不复用沙箱
 * 严格变宽阶梯**——生命周期动词不是文件效果动作，danger 档会话下无更宽目标
 * 会使其结构性不可用；值词汇仍 ∈ 升权目标档闭集（单一归宿，测试锁漂移）。
 *
 * `plugins_uninstall_inspect` = 双相卸载的 inspect 相模型面（effect:'read'）：
 * 卸载执行权在人（/plugin-uninstall --confirm）——模型只草拟报告不执行，
 * 报告尾部固定指引用（模型知道 execute 不归它）。
 *
 * 拓扑最小边（与 plugin.ts 同律）：全部依赖经 ctx.get 运行时服务面取，零跨
 * 模块 import 宿主实现；服务面的结构子集类型本地收窄。升权目标词汇 inline
 * 常量（admin→safety 不开边）+ 测试对 safety ESCALATION_TARGETS 断言锁等值。
 */

import { AppError, SANDBOX_ESCALATION_INVALID, TOOL_ARGUMENTS_INVALID } from '../contracts/errors.js';
import type { AgentToolResult, ToolDefinition } from '../contracts/tools.js';
import { Type } from '../contracts/typebox.js';

/**
 * 生命周期动词可请求的授权目标档闭集（= safety ESCALATION_TARGETS 的本件镜像
 * ——升权词汇单一归宿，勿在别处另立词表；app/plugins.test.ts 锁两侧等值防漂移
 * ——admin 边只有 contracts，app 是两侧唯一合法会师点）。
 * 生命周期档不做严格变宽检查（见模块头）——值合法即入审批。
 */
export const PRIVILEGE_REQUEST_TARGETS: readonly string[] = ['workspace-write', 'danger-full-access'];

/** approval 服务面的结构子集（插件消费面收窄——ask 的 outcome 闭集本地复述） */
export interface ApprovalAskFace {
  /** 动作级审批：一次请求 → 一个 outcome（allowed-once 只授予当次调用） */
  ask(req: {
    readonly summary: string;
    readonly reason?: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
}

/** install/update 回执的结构子集（InstallReport/UpdateReport 本地收窄） */
export interface InstallReportView {
  readonly id: string;
  readonly source: string;
  readonly pluginRef: string;
  readonly message: string;
}

/** configure 回执的结构子集（ConfigureReport 本地收窄） */
export interface ConfigureReportView {
  readonly id: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly appliedKeys: readonly string[];
  readonly ring1RestartRequired: boolean;
  readonly message: string;
}

/** 重载回执三态的结构子集（ReloadOutcome 本地收窄——tagged union 保形） */
export type ReloadOutcomeView =
  | { readonly status: 'queued' }
  | { readonly status: 'done'; readonly failed: readonly string[] }
  | { readonly status: 'error'; readonly message: string };

/** uninstall inspect 报告的结构子集（UninstallReport 本地收窄） */
export interface UninstallReportView {
  readonly id: string;
  readonly source: string;
  readonly status: string;
  readonly pluginRef: string;
  readonly installPath?: string;
  readonly sharedRows: readonly string[];
  readonly dataDir: string;
  readonly dataBytes?: number;
  readonly events: {
    readonly origin: 'live' | 'ledger' | 'unknown';
    readonly names: readonly string[];
    readonly note?: string;
  };
  readonly affectedSessions?: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

/** ctx.plugins 服务面的写动词结构子集（与 plugin.ts 只读面同收窄纪律） */
export interface PluginsManageFace {
  install(ref: string, opts?: { gitRef?: string }): Promise<InstallReportView>;
  toggle(id: string): boolean;
  update(id: string): Promise<InstallReportView>;
  configure(id: string, patch: Readonly<Record<string, unknown>>): Promise<ConfigureReportView>;
  requestReload(): Promise<ReloadOutcomeView>;
  uninstall(id: string, opts: { readonly mode: 'inspect' }): Promise<UninstallReportView>;
}

/** 纯文本结果（AgentToolResult 薄构造——本件工具均纯文本呈现） */
function textResult(text: string): AgentToolResult {
  return { content: [{ type: 'text', text }] };
}

/** 审批对参数的 schema 形态（五写词共用——必填钉死「成对」） */
function pairParameters() {
  return {
    sandbox_permissions: Type.String({
      description: `授权目标档（${PRIVILEGE_REQUEST_TARGETS.join(' 或 ')}）——生命周期动词恒需人批`,
    }),
    justification: Type.String({ minLength: 1, description: '本次动作的理由（随审批弹窗给人看——说明做什么与为什么）' }),
  };
}

/**
 * 生命周期档统一闸（五写词共用的执行前置）：值校验（∈ 目标档闭集——单一归宿
 * 词汇）→ approval.ask（durable 双腿由审批服务承载）。allowed-once → 放行；
 * 其余三态 → isError 结果面返回（拒绝是最终的——同回合不重试）。
 * @returns 放行返回 undefined；拦截返回 isError 结果（调用方直接 return）
 */
async function requestLifecycleApproval(
  approval: ApprovalAskFace,
  input: {
    readonly toolName: string;
    readonly action: string;
    readonly detail: string;
    readonly sandboxPermissions: string;
    readonly justification: string;
    readonly toolCallId: string | undefined;
  },
): Promise<AgentToolResult | undefined> {
  if (!PRIVILEGE_REQUEST_TARGETS.includes(input.sandboxPermissions)) {
    throw new AppError(
      SANDBOX_ESCALATION_INVALID,
      `授权目标档非法：${input.sandboxPermissions}（合法目标：${PRIVILEGE_REQUEST_TARGETS.join(' / ')}）`,
    );
  }
  const outcome = await approval.ask({
    summary: `${input.action}：${input.detail}`,
    reason: `目标档 ${input.sandboxPermissions}；${input.justification}`,
    toolName: input.toolName,
    ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
  });
  if (outcome === 'allowed-once') return undefined;
  return {
    content: [
      {
        type: 'text',
        text: `[审批被拒（${outcome}）] ${input.action} 未执行——${input.detail}。拒绝是最终的：不要重试同请求，向用户说明后按用户意愿行事（命令面 /plugin-* 系动词始终可用）。`,
      },
    ],
    isError: true,
  };
}

/**
 * 构造 `plugins_install` 工具（装机三源分发 + overlay 对账写回——不自动热应用）。
 * 装好只是落盘；生效须显式链 plugins_reload（动词单职责——链式可见）。
 */
export function createPluginsInstallTool(plugins: PluginsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'plugins_install',
    description:
      '安装插件（三源：npm 包名 / git URL / 本地路径）并写进组合树 overlay。只落盘不热应用——装好后须再调 plugins_reload 才生效。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({
      source: Type.String({
        description: '插件来源：npm spec（如 pkg@^2）/ git URL（git@… 或 https://….git）/ 本地路径（./ ../ 绝对路径）',
      }),
      gitRef: Type.Optional(Type.String({ description: '仅 git 源：锁定的分支或 tag（缺省默认分支）' })),
      ...pairParameters(),
    }),
    effect: 'write',
    async execute(args, tctx): Promise<AgentToolResult> {
      const req = args as { source: string; gitRef?: string; sandbox_permissions: string; justification: string };
      const denied = await requestLifecycleApproval(approval, {
        toolName: 'plugins_install',
        action: 'plugins_install',
        detail: `安装插件 ${req.source}`,
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const report = await plugins.install(req.source, req.gitRef !== undefined ? { gitRef: req.gitRef } : undefined);
      return textResult(
        [
          `${report.message}`,
          `行 id：${report.id}（${report.source} 源 · 引用 ${report.pluginRef}）`,
          '已写 overlay——尚未生效：下一步调 plugins_reload 重载组合树。',
        ].join('\n'),
      );
    },
  };
}

/** 构造 `plugins_update` 工具（按源分派更新：npm 重装 / git 重克隆 / local 对账 no-op）。 */
export function createPluginsUpdateTool(plugins: PluginsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'plugins_update',
    description:
      '更新插件行：npm 源重装解析新版本 / git 源按原 ref 重克隆 / local 源改动即见（仅刷新词表账本）。更新后须 plugins_reload 生效。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({
      id: Type.String({ description: '组合树行 id（以 plugins_list 为准）' }),
      ...pairParameters(),
    }),
    effect: 'write',
    async execute(args, tctx): Promise<AgentToolResult> {
      const req = args as { id: string; sandbox_permissions: string; justification: string };
      const denied = await requestLifecycleApproval(approval, {
        toolName: 'plugins_update',
        action: 'plugins_update',
        detail: `更新插件行 ${req.id}`,
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const report = await plugins.update(req.id);
      return textResult([report.message, '更新后调 plugins_reload 生效。'].join('\n'));
    },
  };
}

/** 构造 `plugins_toggle` 工具（行禁用状态翻转——真·可卸的启停面）。 */
export function createPluginsToggleTool(plugins: PluginsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'plugins_toggle',
    description:
      '翻转插件行启用/禁用状态（Ring 2 行可禁用可启用；Ring 1 必备行与 fixed 行禁用即拒）。翻转后须 plugins_reload 生效。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({
      id: Type.String({ description: '组合树行 id（以 plugins_list 为准）' }),
      ...pairParameters(),
    }),
    effect: 'write',
    async execute(args, tctx): Promise<AgentToolResult> {
      const req = args as { id: string; sandbox_permissions: string; justification: string };
      const denied = await requestLifecycleApproval(approval, {
        toolName: 'plugins_toggle',
        action: 'plugins_toggle',
        detail: `翻转插件行 ${req.id} 的启停状态`,
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const nowDisabled = plugins.toggle(req.id);
      return textResult(
        [
          `行 ${req.id} 现已${nowDisabled ? '禁用' : '启用'}（overlay 已写回）。`,
          nowDisabled ? '禁用即真·可卸：核心循环不依赖该行时安全。' : '启用恢复装载。',
          '调 plugins_reload 生效。',
        ].join('\n'),
      );
    },
  };
}

/** 构造 `plugins_configure` 工具（行配置写入——patch 顶层键整值替换 + schema 校验）。 */
export function createPluginsConfigureTool(plugins: PluginsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'plugins_configure',
    description:
      '修改插件行配置：patch 按顶层键整值替换合并进现行配置，经插件声明 schema 校验后写 overlay（校验不过即拒、不落盘）。禁用/未装/未激活行拒写。配置后须 plugins_reload 生效。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({
      id: Type.String({ description: '组合树行 id（以 plugins_list 为准）' }),
      config: Type.Record(Type.String(), Type.Unknown(), {
        description: '配置 patch：顶层键整值替换（要改哪些键就带哪些键——未列出的键保持现值；不做深合并）',
      }),
      ...pairParameters(),
    }),
    effect: 'write',
    async execute(args, tctx): Promise<AgentToolResult> {
      const req = args as {
        id: string;
        config: Record<string, unknown>;
        sandbox_permissions: string;
        justification: string;
      };
      // 空 patch 先响（参数面可修复错误——不带进审批弹窗浪费一次人批）
      assertNonEmptyPatch(req.config);
      const denied = await requestLifecycleApproval(approval, {
        toolName: 'plugins_configure',
        action: 'plugins_configure',
        detail: `修改插件行 ${req.id} 的配置（键：${Object.keys(req.config).join('、') || '（空）'}）`,
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const report = await plugins.configure(req.id, req.config);
      const lines = [report.message, `合并后完整配置：${JSON.stringify(report.config)}`];
      if (report.ring1RestartRequired) lines.push('注意：Ring 1 必备行不随 /reload 热装载——本次写入须重启进程生效。');
      return textResult(lines.join('\n'));
    },
  };
}

/** 构造 `plugins_reload` 工具（组合树热重载请求——排队语义宿主侧承载）。 */
export function createPluginsReloadTool(plugins: PluginsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'plugins_reload',
    description:
      '请求热重载组合树（卸载半边回卷 → 重读 overlay → 重装）。run 进行中不拒——排队，本次 run 结算后自动执行。install/update/toggle/configure 的生效尾步。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({ ...pairParameters() }),
    effect: 'write',
    async execute(args, tctx): Promise<AgentToolResult> {
      const req = args as { sandbox_permissions: string; justification: string };
      const denied = await requestLifecycleApproval(approval, {
        toolName: 'plugins_reload',
        action: 'plugins_reload',
        detail: '热重载插件组合树（全部插件卸载重装）',
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const outcome = await plugins.requestReload();
      switch (outcome.status) {
        case 'queued':
          return textResult(
            '已排队：当前有 run 在跑，本次 run 结算后自动执行重载（连发合并为一次），结果经通知送达——无需再次请求。',
          );
        case 'done':
          return textResult(
            outcome.failed.length > 0
              ? `重载完成，但有失败行：${outcome.failed.join('、')}（进程存活、旧注册已回卷——用 plugins_list 看逐行原因，修 overlay 后再 plugins_reload）`
              : '重载完成：组合树已按最新 overlay 装载（结果详见 composition/reloaded 事件）。',
          );
        case 'error':
          return {
            content: [{ type: 'text', text: `重载失败：${outcome.message}\n旧装配未动仍在运行——修 overlay 后重试。` }],
            isError: true,
          };
      }
    },
  };
}

/** 构造 `plugins_uninstall_inspect` 工具（双相卸载 inspect 相——只读检视，执行权在人）。 */
export function createPluginsUninstallInspectTool(plugins: PluginsManageFace): ToolDefinition {
  return {
    name: 'plugins_uninstall_inspect',
    description:
      '卸载预检（只读零副作用）：行现状、装机物、数据域体积、自定义事件词与受影响会话数、级联警示。卸载执行权在人——检视后指引 /plugin-uninstall <id> --confirm 执行。',
    parameters: Type.Object({
      id: Type.String({ description: '组合树行 id（以 plugins_list 为准）' }),
    }),
    effect: 'read',
    async execute(args): Promise<AgentToolResult> {
      const report = await plugins.uninstall(String((args as { id: string }).id), { mode: 'inspect' });
      const lines: string[] = [
        `卸载预检——行 ${report.id}（${report.source} 源 · 现状态 ${report.status} · 引用 ${report.pluginRef}）：`,
        report.installPath !== undefined ? `- 装机物：${report.installPath}` : '- 装机物：无（代码随包或用户自有目录）',
        report.sharedRows.length > 0
          ? `- 装机物被共享：${report.sharedRows.join('、')}（执行时跳删装机物）`
          : '- 装机物无共享行（执行时删除）',
        `- 数据域：${report.dataDir}${report.dataBytes !== undefined ? `（体积 ${report.dataBytes} 字节，默认保留；--purge-data 才删）` : '（不存在）'}`,
        `- 自定义事件词（${report.events.origin} 档）：${report.events.names.length > 0 ? report.events.names.join('、') : '（无）'}`,
      ];
      if (report.affectedSessions !== undefined) {
        const affected = Object.entries(report.affectedSessions).filter(([, n]) => n > 0);
        lines.push(
          affected.length > 0
            ? `- 受影响会话：${affected.map(([word, n]) => `${word}×${n}`).join('、')}`
            : '- 受影响会话：无',
        );
      }
      for (const warning of report.warnings) lines.push(`- 警示：${warning}`);
      lines.push(
        `执行权在人：把本报告呈给用户，由用户运行 /plugin-uninstall ${report.id} --confirm（加 --purge-data 连数据域清除）——你不可执行卸载。`,
      );
      return textResult(lines.join('\n'));
    },
  };
}

/** 参数面校验兜底：空 config patch 在工具层先响（服务面同款拒绝为纵深第二道） */
export function assertNonEmptyPatch(patch: Record<string, unknown>): void {
  if (Object.keys(patch).length === 0) {
    throw new AppError(TOOL_ARGUMENTS_INVALID, 'config patch 键集为空——要改哪些顶层键就带哪些键');
  }
}
