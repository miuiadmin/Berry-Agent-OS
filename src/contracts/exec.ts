/**
 * L0 contracts — exec 原语契约（骨架篇 §9.3 ctx.exec 全文签名 + §7.6 bash 工具；
 * 2026-08-25 exec 纵切规范先行轮定稿，本批落码）。
 *
 * 三类词汇：
 * 1. ExecOptions/ExecResult/ExecEnvTable——ctx.exec 原语侧载荷（bash 工具侧
 *    参数面是它的窄化：无 stdin/env——刻意不对称，骨架篇 §7.6）；
 * 2. ExecService——ctx.exec 服务面（插件经 ctx.get<ExecService>('exec') 取用；
 *    与 bash 工具同一条三段管道，不旁路——地基篇 Q3）；
 * 3. 沙箱元数据 SandboxMeta——bash 工具与 ctx.exec 结果共携（denied 按
 *    后端 denialSignatures 分类 stderr 的命中清单）。
 *
 * 失败强制二分（pi-7 教训：pi 生态吞 spawn 错误逼出七条正则嗅探）：
 * - 未启动（spawn 即败：ENOENT/EACCES/E2BIG）= AppError EXEC_SPAWN_FAILED
 *   （message 携 Node cause.code，绝不折算 exit 1）；
 * - 已启动退出非零 = 正常返回 { exitCode, stderr }——不是错误。
 */

/** 沙箱元数据（bash 工具结果与 ExecResult 共携；骨架篇 §7.6） */
export interface SandboxMeta {
  /** 本次实际生效档位（升权 allowed-once 时为审批产物档） */
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** stderr 命中后端「策略拒绝」签名的列表（空数组 = 未命中——命令正常跑完） */
  readonly denied: readonly string[];
  /** 强制完整性：full = 内核级后端生效 / partial = 后端自报受限 / none = danger 透传未包装 */
  readonly enforcement: 'full' | 'partial' | 'none';
}

/**
 * 子进程环境声明式变更表（骨架篇 §9.3；契约篇 §1.2 E 组执法面②）——
 * deny-by-default 白名单之上的显式叠加：
 * - 隐式继承 = 白名单命中者自动透传（机器运行必需族 + 证书 + 代理）；
 * - inherit = 显式追加透传名单（命中凭证族/宿主保留前缀 = EXEC_ENV_FORBIDDEN
 *   响亮拒——机器堵的是名单走私；值本身取自宿主进程环境，缺者跳过）；
 * - set = 显式值任意名合法（凭证经 config/凭证库正路取得后显式传递合法）；
 * - unset = 从最终环境移除该名（可撤白名单内的名字）。
 */
export interface ExecEnvTable {
  /** 显式追加透传的宿主环境变量名 */
  readonly inherit?: readonly string[];
  /** 显式设置的变量值（任意名合法） */
  readonly set?: Readonly<Record<string, string>>;
  /** 显式移除的变量名 */
  readonly unset?: readonly string[];
}

/** ctx.exec 原语侧选项（bash 工具侧无 env/stdin——两侧不对称是刻意的） */
export interface ExecOptions {
  /** 工作目录（缺省宿主 cwd；调用方自行保证落在其许可边界内） */
  readonly cwd?: string;
  /** 超时毫秒（到点按进程组纪律树杀并抛 TOOL_TIMEOUT——码族复用，不另立） */
  readonly timeoutMs?: number;
  /** 取消信号（abort 即树杀；结果按已启动处理，signal 字段记 SIGTERM） */
  readonly signal?: AbortSignal;
  /** UTF-8 写入子进程 stdin 后关闭（v1 无流式喂入——模型工具侧无此面） */
  readonly stdin?: string;
  /** 环境声明式变更表（白名单之上的叠加；见 ExecEnvTable） */
  readonly env?: ExecEnvTable;
  /** 流式增量回调（run-to-completion 单品是 pi-7 反面——执行中即推） */
  readonly onOutput?: (chunk: { readonly stream: 'stdout' | 'stderr'; readonly text: string }) => void;
}

/** ctx.exec 原语侧结果（退出非零是正常返回不是错误——失败二分） */
export interface ExecResult {
  /** 退出码（被信号杀死时为 null，见 signal 字段） */
  readonly exitCode: number | null;
  /** 标准输出（UTF-8；超出输出预算部分保尾截断，见 truncated） */
  readonly stdout: string;
  /** 标准错误（分列字段——渲染层再合并展示） */
  readonly stderr: string;
  /** 输出是否被预算截断（stdout+stderr 合并预算，保尾） */
  readonly truncated: boolean;
  /** 执行时长毫秒（spawn 到 close） */
  readonly durationMs: number;
  /** 子进程被信号杀死时的信号名（正常退出为 undefined） */
  readonly signal?: string;
  /** 沙箱元数据（与 bash 工具同构） */
  readonly sandbox: SandboxMeta;
}

/**
 * ctx.exec 服务面（骨架篇 §9.3 防旁路声明）：与模型可调用的 bash 工具走
 * **同一条三段 waterfall**——服务内部合成内部 ToolDefinition（名 `exec`，
 * 不进模型词汇表）+ 内部 toolCallId，守门段照过、gate/decision 照落账。
 */
export interface ExecService {
  /** 受守门段管辖的 shell 执行便捷口（与 bash 工具同一管道，不旁路） */
  exec(cmd: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
}
