/**
 * L4 admin — 管理件写类动词八工具（契约篇 §3.4 刀 2 工具族与 Skill 兑现条，
 * 2026-08-27 刀 3 落码；默认层 admin 行内注册，effect:'write' 七词 + read 一词。
 * D2 装机两态批（2026-08-27 第三十批）扩 mount/unmount 两词——写行类模型可用，
 * install 随两态改仓库态〔不写组合行〕，update/uninstall_inspect 键域迁装机 id）。
 *
 * 三档分级的落码形态：本文件写词全走「生命周期档」——参数面强制审批对
 * （sandbox_permissions + justification 成对非空，schema 必填钉死）→ 值校验 →
 * approval.ask（asked/decided 双腿落 durable 由审批服务免费承载）→
 * allowed-once 才调服务面。**生命周期档复用 bash 升权闭包先例的四件套机制
 * （成对面纪律 / approval.ask / allowed-once / durable 落账）但不复用沙箱
 * 严格变宽阶梯**——生命周期动词不是文件效果动作，danger 档会话下无更宽目标
 * 会使其结构性不可用；值词汇仍 ∈ 升权目标档闭集（单一归宿，测试锁漂移）。
 *
 * `apps_uninstall_inspect` = 双相卸载的 inspect 相模型面（effect:'read'）：
 * 卸载执行权在人（/apps-uninstall --confirm）——模型只草拟报告不执行，
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
 * ——升权词汇单一归宿，勿在别处另立词表；app/apps.test.ts 锁两侧等值防漂移
 * ——admin 边只有 contracts，app 是两侧唯一合法会师点）。
 * 生命周期档不做严格变宽检查（见模块头）——值合法即入审批。
 */
export const PRIVILEGE_REQUEST_TARGETS: readonly string[] = ['workspace-write', 'danger-full-access'];

/** approval 服务面的结构子集（应用消费面收窄——ask 的 outcome 闭集本地复述） */
export interface ApprovalAskFace {
  /** 动作级审批：一次请求 → 一个 outcome（allowed-once 只授予当次调用） */
  ask(req: {
    readonly summary: string;
    readonly reason?: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
}

/** install 回执的结构子集（InstallReport 本地收窄——D2 仓库态：无行写入） */
export interface InstallReportView {
  readonly id: string;
  readonly source: string;
  readonly appRef: string;
  readonly message: string;
}

/** update 回执的结构子集（UpdateReport 本地收窄——D2 键域 = 装机 id，无 appRef） */
export interface UpdateReportView {
  readonly id: string;
  readonly source: string;
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

/** 重载回执三态的结构子集（ReloadOutcome 本地收窄——tagged union 保形；done 腿含 D3 单区两可选面） */
export type ReloadOutcomeView =
  | { readonly status: 'queued' }
  | {
      readonly status: 'done';
      readonly failed: readonly string[];
      /** 单区 reload 目标应用（D3——缺席 = 全量） */
      readonly app?: string;
      /** 卸词集警示（D3——该区旧词 ∖ 新词） */
      readonly droppedEvents?: readonly string[];
    }
  | { readonly status: 'error'; readonly message: string };

/** uninstall inspect 报告的结构子集（UninstallReport 本地收窄——D2 键域 = 装机 id） */
export interface UninstallReportView {
  readonly id: string;
  readonly source: string;
  readonly appRef: string;
  readonly installPath: string;
  readonly mountedRows: readonly string[];
  readonly dataRoots: readonly string[];
  readonly dataBytes?: number;
  readonly events: {
    readonly origin: 'live' | 'ledger' | 'unknown';
    readonly names: readonly string[];
    readonly note?: string;
  };
  readonly affectedSessions?: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

/** mount 回执的结构子集（MountReport 本地收窄；第三十六批 apps 数组化） */
export interface MountReportView {
  readonly id: string;
  readonly apps: readonly string[];
  readonly source: string;
  readonly appRef: string;
  readonly message: string;
}

/** unmount 回执的结构子集（UnmountReport 本地收窄） */
export interface UnmountReportView {
  readonly id: string;
  /** 被删行挂载目标集（R4 行为小刀）——恰一元素 = 单区 reload 提示的判据 */
  readonly apps: readonly string[];
  readonly warnings: readonly string[];
  readonly message: string;
}

/** ctx.apps 服务面的写动词结构子集（与 plugin.ts 只读面同收窄纪律） */
export interface AppsManageFace {
  install(ref: string, opts?: { gitRef?: string }): Promise<InstallReportView>;
  toggle(id: string): boolean;
  update(id: string): Promise<UpdateReportView>;
  mount(
    installId: string,
    opts?: {
      apps?: readonly string[];
      carrier?: 'main' | 'worker' | 'external';
      config?: Record<string, unknown>;
      rowId?: string;
    },
  ): Promise<MountReportView>;
  unmount(rowId: string): Promise<UnmountReportView>;
  configure(id: string, patch: Readonly<Record<string, unknown>>): Promise<ConfigureReportView>;
  requestReload(opts?: { readonly app?: string }): Promise<ReloadOutcomeView>;
  uninstall(id: string, opts: { readonly mode: 'inspect' }): Promise<UninstallReportView>;
}

/** 纯文本结果（AgentToolResult 薄构造——本件工具均纯文本呈现） */
function textResult(text: string): AgentToolResult {
  return { content: [{ type: 'text', text }] };
}

/** 审批对参数的 schema 形态（全部写词共用——必填钉死「成对」） */
function pairParameters() {
  return {
    sandbox_permissions: Type.String({
      description: `授权目标档（${PRIVILEGE_REQUEST_TARGETS.join(' 或 ')}）——生命周期动词恒需人批`,
    }),
    justification: Type.String({ minLength: 1, description: '本次动作的理由（随审批弹窗给人看——说明做什么与为什么）' }),
  };
}

/**
 * 生命周期档统一闸（全部写词共用的执行前置）：值校验（∈ 目标档闭集——单一归宿
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
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
  });
  if (outcome === 'allowed-once') return undefined;
  return {
    content: [
      {
        type: 'text',
        text: `[审批被拒（${outcome}）] ${input.action} 未执行——${input.detail}。拒绝是最终的：不要重试同请求，向用户说明后按用户意愿行事（命令面 /apps-* 系动词始终可用）。`,
      },
    ],
    isError: true,
  };
}

/**
 * 构造 `apps_install` 工具（装机三源分发 + provenance 落账——仓库态，不写组合行）。
 * 装好 = 入仓待挂，对宿主运行时零生效；生效须显式链 apps_mount → apps_reload
 * （两态批：install 零行无物可热应用，不再链 reload）。
 */
export function createAppsInstallTool(apps: AppsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'apps_install',
    description:
      '安装应用（三源：npm 包名 / git URL / 本地路径）到装机仓库并落 provenance 账。仓库态零生效——不写组合树行、不进装载序；生效须再调 apps_mount 挂载到应用。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({
      source: Type.String({
        description: '应用来源：npm spec（如 pkg@^2）/ git URL（git@… 或 https://….git）/ 本地路径（./ ../ 绝对路径）',
      }),
      gitRef: Type.Optional(Type.String({ description: '仅 git 源：锁定的分支或 tag（缺省默认分支）' })),
      ...pairParameters(),
    }),
    effect: 'write',
    async execute(args, tctx): Promise<AgentToolResult> {
      const req = args as { source: string; gitRef?: string; sandbox_permissions: string; justification: string };
      const denied = await requestLifecycleApproval(approval, {
        toolName: 'apps_install',
        action: 'apps_install',
        detail: `安装应用 ${req.source}（仓库态，不生效）`,
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const report = await apps.install(req.source, req.gitRef === undefined ? undefined : { gitRef: req.gitRef });
      return textResult(
        [
          `${report.message}`,
          `装机 id：${report.id}（${report.source} 源 · 引用 ${report.appRef}）——已在仓库待挂。`,
          `仓库态零生效：下一步调 apps_mount（install_id=${report.id}，apps 必填）写组合行，再 apps_reload 生效。`,
        ].join('\n'),
      );
    },
  };
}

/**
 * 构造 `apps_mount` 工具（写组合行 = 挂载生效动词——D2 两态批新增；第三十六批
 * apps 数组化 + R1 复盘批 carrier 解冻三值收口）。吃装机 id（provenance 账本键）；
 * 挂载目标 = 应用 id 数组（多值 = 共享件；v1 第三方件必须挂应用，系统层官方
 * 专属）；carrier = 显式降格位（三值：缺省不落 sandbox 块 = 闩一装载期推
 * external 进程墙；main/worker = operator 显式降格；external = 与缺省等价）；
 * 行 id 缺省 = 装机推导 id。写行后热应用链 = apps_reload。
 */
export function createAppsMountTool(apps: AppsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'apps_mount',
    description:
      '挂载已装机应用到应用（写组合树行 = 生效动词）：install 只入仓库，本动词写行挂载。挂载目标应用必填（数组，多值 = 多应用共享件；v1 第三方件必须挂应用，不可挂系统层）；载体缺省 = external 进进程墙（闩一，无需声明），carrier 可显式降格 main|worker（operator 裁量）；行 id 缺省 = 装机 id。写行后须 apps_reload 生效。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({
      installId: Type.String({
        description: '装机 id（apps_install 回执或 apps_list 的 installed-unmounted 行——以账本为准）',
      }),
      apps: Type.Array(Type.String(), {
        description: '挂载目标应用 id 数组（如 ["chat"]；多元素 = 共享件一行投多应用——v1 第三方件必须挂应用）',
      }),
      carrier: Type.Optional(
        Type.Union([Type.Literal('main'), Type.Literal('worker'), Type.Literal('external')], {
          description:
            '沙箱载体显式位（缺省不落 sandbox 块 = external 进程墙〔闩一，推荐〕；main = 宿主进程域裸信任 / worker = 工作进程域故障分域——均为 operator 显式降格；external = 与缺省等价的显式声明）',
        }),
      ),
      rowId: Type.Optional(
        Type.String({ description: '组合树行 id 显式命名（缺省 = 装机 id；同包第二次挂载〔第二应用〕必带防撞名）' }),
      ),
      config: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            '行配置（可选；仅 carrier=main 可携带——分域行〔worker/external/缺省闩一〕config 校验面在域侧，宿主代校验打穿进程墙即拒；main 行经应用声明 schema 校验，不过即拒、不落盘）',
        }),
      ),
      ...pairParameters(),
    }),
    effect: 'write',
    async execute(args, tctx): Promise<AgentToolResult> {
      const req = args as {
        installId: string;
        apps: string[];
        carrier?: 'main' | 'worker' | 'external';
        rowId?: string;
        config?: Record<string, unknown>;
        sandbox_permissions: string;
        justification: string;
      };
      // 可选 config 的空对象先响（参数面可修复错误——不带进审批弹窗浪费一次人批）
      if (req.config !== undefined && Object.keys(req.config).length === 0) {
        throw new AppError(TOOL_ARGUMENTS_INVALID, 'config 键集为空——要配置哪些键就带哪些键，不配置则省略 config');
      }
      const denied = await requestLifecycleApproval(approval, {
        toolName: 'apps_mount',
        action: 'apps_mount',
        detail: `挂载应用 ${req.installId} 到应用 ${req.apps.join('、')}${req.rowId === undefined ? '' : `（行 id ${req.rowId}）`}`,
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const report = await apps.mount(req.installId, {
        apps: req.apps,
        ...(req.carrier === undefined ? {} : { carrier: req.carrier }),
        ...(req.rowId === undefined ? {} : { rowId: req.rowId }),
        ...(req.config === undefined ? {} : { config: req.config }),
      });
      return textResult(
        [
          `${report.message}`,
          `行 ${report.id}：挂应用 ${report.apps.join('、')}（${report.source} 源 · 引用 ${report.appRef}）。`,
          // 单区提示（R4 行为小刀同刀）：恰一应用 = 该区行，apps_reload 带 app 单区即可
          `行已写但尚未装载：调 apps_reload${
            report.apps.length === 1 ? `（app="${report.apps[0]}" 单区即可）` : ''
          } 生效。`,
        ].join('\n'),
      );
    },
  };
}

/**
 * 构造 `apps_unmount` 工具（删行保码——mount 对偶，D2 两态批新增）。
 * 吃组合树行 id；装机物与 provenance 账本保留（重挂走 apps_mount）；
 * 受影响会话警示走 uninstall inspect 同款呈现。
 */
export function createAppsUnmountTool(apps: AppsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'apps_unmount',
    description:
      '摘除应用挂载（删组合树行，保装机物与账本——重挂走 apps_mount）。吃组合树行 id；受影响会话警示随回执呈报。临时停用保配置走 apps_toggle，移出组合树才用本动词。写行后须 apps_reload 生效。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({
      rowId: Type.String({ description: '组合树行 id（以 apps_list 为准）' }),
      ...pairParameters(),
    }),
    effect: 'write',
    async execute(args, tctx): Promise<AgentToolResult> {
      const req = args as { rowId: string; sandbox_permissions: string; justification: string };
      const denied = await requestLifecycleApproval(approval, {
        toolName: 'apps_unmount',
        action: 'apps_unmount',
        detail: `摘除应用挂载 ${req.rowId}（删行保码）`,
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const report = await apps.unmount(req.rowId);
      const lines = [
        `${report.message}`,
        `行 ${report.id} 已删——装机物保留在仓库（installed-unmounted 态），重挂走 apps_mount。`,
      ];
      // 受影响会话警示逐条呈报（词表 unknown 档 = 最坏假设的既定文案，直接透传）
      for (const warning of report.warnings) lines.push(`警示：${warning}`);
      // 单区提示同 mount 工具（R4 行为小刀同刀）：恰一目标应用 = 该区行
      lines.push(`调 apps_reload${report.apps.length === 1 ? `（app="${report.apps[0]}" 单区即可）` : ''} 生效。`);
      return textResult(lines.join('\n'));
    },
  };
}

/** 构造 `apps_update` 工具（按源分派更新：npm 重装 / git 重克隆 / local no-op——键域 = 装机 id）。 */
export function createAppsUpdateTool(apps: AppsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'apps_update',
    description:
      '更新已装机应用（键域 = 装机 id，非组合树行 id——仓库态未挂载件同样可更新）：npm 源重装解析新版本 / git 源按原 ref 重克隆 / local 源改动即见（仅刷新账本）。更新后须 apps_reload 生效。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({
      id: Type.String({ description: '装机 id（以 apps_list 为准——含 installed-unmounted 态行）' }),
      ...pairParameters(),
    }),
    effect: 'write',
    async execute(args, tctx): Promise<AgentToolResult> {
      const req = args as { id: string; sandbox_permissions: string; justification: string };
      const denied = await requestLifecycleApproval(approval, {
        toolName: 'apps_update',
        action: 'apps_update',
        detail: `更新已装机应用 ${req.id}`,
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const report = await apps.update(req.id);
      return textResult([report.message, '更新后调 apps_reload 生效。'].join('\n'));
    },
  };
}

/** 构造 `apps_toggle` 工具（行禁用状态翻转——真·可卸的启停面）。 */
export function createAppsToggleTool(apps: AppsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'apps_toggle',
    description:
      '翻转应用行启用/禁用状态（Ring 2 行可禁用可启用；Ring 1 必备行与 fixed 行禁用即拒）。翻转后须 apps_reload 生效。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({
      id: Type.String({ description: '组合树行 id（以 apps_list 为准）' }),
      ...pairParameters(),
    }),
    effect: 'write',
    async execute(args, tctx): Promise<AgentToolResult> {
      const req = args as { id: string; sandbox_permissions: string; justification: string };
      const denied = await requestLifecycleApproval(approval, {
        toolName: 'apps_toggle',
        action: 'apps_toggle',
        detail: `翻转应用行 ${req.id} 的启停状态`,
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const nowDisabled = apps.toggle(req.id);
      return textResult(
        [
          `行 ${req.id} 现已${nowDisabled ? '禁用' : '启用'}（overlay 已写回）。`,
          nowDisabled ? '禁用即真·可卸：核心循环不依赖该行时安全。' : '启用恢复装载。',
          '调 apps_reload 生效。',
        ].join('\n'),
      );
    },
  };
}

/** 构造 `apps_configure` 工具（行配置写入——patch 顶层键整值替换 + schema 校验）。 */
export function createAppsConfigureTool(apps: AppsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'apps_configure',
    description:
      '修改应用行配置：patch 按顶层键整值替换合并进现行配置，经应用声明 schema 校验后写 overlay（校验不过即拒、不落盘）。禁用/未装/未激活行拒写。配置后须 apps_reload 生效。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({
      id: Type.String({ description: '组合树行 id（以 apps_list 为准）' }),
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
        toolName: 'apps_configure',
        action: 'apps_configure',
        detail: `修改应用行 ${req.id} 的配置（键：${Object.keys(req.config).join('、') || '（空）'}）`,
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const report = await apps.configure(req.id, req.config);
      const lines = [report.message, `合并后完整配置：${JSON.stringify(report.config)}`];
      if (report.ring1RestartRequired) lines.push('注意：Ring 1 必备行不随 /reload 热装载——本次写入须重启进程生效。');
      return textResult(lines.join('\n'));
    },
  };
}

/** 构造 `apps_reload` 工具（组合树热重载请求——排队语义宿主侧承载）。 */
export function createAppsReloadTool(apps: AppsManageFace, approval: ApprovalAskFace): ToolDefinition {
  return {
    name: 'apps_reload',
    description:
      '请求热重载组合树（卸载半边回卷 → 重读 overlay → 重装）。app 参数 = 单区重载（只动该应用第三方挂载行，他应用运行时不换；缺席 = 全量）。run 进行中不拒——排队，本次 run 结算后自动执行。install/update/toggle/configure 的生效尾步。需审批（sandbox_permissions + justification 必填）。',
    parameters: Type.Object({
      ...pairParameters(),
      /** 单区 reload 目标应用（D3 per-app reload——缺席 = 全量） */
      app: Type.Optional(
        Type.String({ description: '单区重载目标应用 id（只动该应用的第三方挂载行；省略 = 全量重载）' }),
      ),
    }),
    effect: 'write',
    async execute(args, tctx): Promise<AgentToolResult> {
      const req = args as { sandbox_permissions: string; justification: string; app?: string };
      const denied = await requestLifecycleApproval(approval, {
        toolName: 'apps_reload',
        action: 'apps_reload',
        detail:
          req.app === undefined
            ? '热重载应用组合树（全部应用卸载重装）'
            : `热重载应用 ${req.app} 的挂载行（单区——他应用运行时不换）`,
        sandboxPermissions: req.sandbox_permissions,
        justification: req.justification,
        toolCallId: tctx?.toolCallId,
      });
      if (denied !== undefined) return denied;
      const outcome = await apps.requestReload(req.app === undefined ? undefined : { app: req.app });
      switch (outcome.status) {
        case 'queued':
          return textResult(
            '已排队：当前有 run 在跑，本次 run 结算后自动执行重载（连发合并为一次），结果经通知送达——无需再次请求。',
          );
        case 'done': {
          // 单区两腿进回执（D3）：目标应用 + 卸词集警示（词消失按词表三档 unknown 档处理）
          const scope = outcome.app === undefined ? '全量' : `应用 ${outcome.app} 单区`;
          const dropped =
            outcome.droppedEvents !== undefined && outcome.droppedEvents.length > 0
              ? `\n警示：${scope}重载后事件词消失——${outcome.droppedEvents.join('、')}（重装即回；改名即旧词永失，消费方按 unknown 档处理）。`
              : '';
          return textResult(
            outcome.failed.length > 0
              ? `${scope}重载完成，但有失败行：${outcome.failed.join('、')}（进程存活、旧注册已回卷——用 apps_list 看逐行原因，修 overlay 后再 apps_reload）${dropped}`
              : `${scope}重载完成：组合树已按最新 overlay 装载（结果详见 composition/reloaded 事件）。${dropped}`,
          );
        }
        case 'error':
          return {
            content: [{ type: 'text', text: `重载失败：${outcome.message}\n旧装配未动仍在运行——修 overlay 后重试。` }],
            isError: true,
          };
      }
    },
  };
}

/** 构造 `apps_uninstall_inspect` 工具（双相卸载 inspect 相——只读检视，执行权在人）。 */
export function createAppsUninstallInspectTool(apps: AppsManageFace): ToolDefinition {
  return {
    name: 'apps_uninstall_inspect',
    description:
      '卸载预检（只读零副作用，键域 = 装机 id 非行 id）：装机物、全部挂载行（含各应用挂载行）、数据域体积、自定义事件词与受影响会话数、级联警示。卸载 = 删装机物 + 全部挂载行 + 数据域；执行权在人——检视后指引 /apps-uninstall <装机id> --confirm 执行。',
    parameters: Type.Object({
      id: Type.String({ description: '装机 id（以 apps_list 为准——卸载删的是装机物与全部挂载行，非单行）' }),
    }),
    effect: 'read',
    async execute(args): Promise<AgentToolResult> {
      const report = await apps.uninstall(String((args as { id: string }).id), { mode: 'inspect' });
      const lines: string[] = [
        `卸载预检——装机 ${report.id}（${report.source} 源 · 引用 ${report.appRef}）：`,
        `- 装机物：${report.installPath}`,
        report.mountedRows.length > 0
          ? `- 全部挂载行：${report.mountedRows.join('、')}（执行时同批删——卸载是装机级动作）`
          : '- 挂载行：无（仓库态件——纯卸码零组合树变更）',
        report.dataRoots.length > 0
          ? `- 数据域：${report.dataRoots.join('、')}${report.dataBytes === undefined ? '' : `（合计 ${report.dataBytes} 字节，默认保留；--purge-data 才删）`}`
          : '- 数据域：无',
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
        `执行权在人：把本报告呈给用户，由用户运行 /apps-uninstall ${report.id} --confirm（加 --purge-data 连数据域清除）——你不可执行卸载。`,
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
