/**
 * L4 chat — todo gates 验证器族 + 段约束执法（骨架篇 §6.8 刀二：T3-A 机器可验
 * 完成判据 + T2-A 段约束；与 DiscoveryGates 同构纯函数——可单测、数据面闭包
 * 注入、件零表知识，同一闸门机器的判据扩展非第二闸门机器）。
 *
 * 双执法位全在 todo 工具执行段（冷读复审 NEW-2 拍死——typebox schema 驱动
 * open 时静态注册、上下文盲，段语义无从在 schema 落）：
 * - **段约束**（enforceTodoScope）：goal 段 → deferred 必携 resume_when〔词法
 *   校验〕+ completed 强制 follow_up / no_follow_up 二择一；非 goal 段 →
 *   goal 段词汇申报即拒（role/task_class/resume_when/deferred/follow_up/
 *   no_follow_up/gate——「goal 段词汇不悬空」红线，静默吞字段违诚实原则）。
 *   违规拒 GOAL_TODO_SCOPE。
 * - **gates**（runTodoGates）：置 completed 且该项带 gate → 同步执行验证器；
 *   不过/超时/畸形/审批拒 = fail-closed——置 completed 被拒（todo/write 不
 *   落账），GOAL_GATE_FAILED 结构化回执（kind + reason）。
 *
 * 验证器只做机制边界判定，不做内容分析（letta token 扫描被绕过教训——判定
 * 面 = 退出码/文件真相/诊断级，永不读语义）。失败原因税目五值（冷读 CR-22：
 * 无独立判据面的枚举值不立——不设 dirty 值）：
 *   nonzero  = 判据信号不绿（command 退出码非零 / diagnostics error 级在场）
 *   timeout  = 超时（command 30s 帽）
 *   malformed = 判据面畸形（spec 形状错 / 诊断未回流〔陈旧·版本不齐族〕）
 *   denied   = 审批拒（command gate 未获 needsWrite / 守门·升权被拒）
 *   missing  = 目标缺席（files 缺文件·空文件·根外 / diagnostics 面缺席·文件不在盘）
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppError, GOAL_TODO_SCOPE, TOOL_BLOCKED, TOOL_TIMEOUT, describeError } from '../contracts/errors.js';
import { canonicalPath, isInsideRoot } from '../safety/roots.js';
import type { TodoItem, TodoGate } from './todo.js';

/* ---------------- resume_when 词法（v1 只收时间形——冷读 CR-16） ---------------- */

/** 相对窗量词（after@+<n>[mhd] 的单位段） */
const RELATIVE_RESUME = /^after@\+([1-9][0-9]{0,4})([mhd])$/;

/**
 * 校验 resume_when 词法：`after@<ISO>`（绝对时刻）| `after@+<n>[mhd]`（相对
 * 窗）。可 parse 可判窗是机器复评的前置（无语法即无从复评）；复杂条件明示
 * v1 不收。返回 true = 合法词形。
 */
export function isValidResumeWhen(value: string): boolean {
  if (RELATIVE_RESUME.test(value)) return true;
  if (!value.startsWith('after@')) return false;
  const when = value.slice('after@'.length);
  if (when === '' || when.length > 32 || /\s/.test(when)) return false;
  const parsed = Date.parse(when);
  return !Number.isNaN(parsed);
}

/* ---------------- 段约束执法（T2-A——todo 执行段位） ---------------- */

/**
 * goal 段视野（组合根通道 goalScopeFor 的窄面——chat 侧结构兼容形状；
 * undefined = 非 goal 段〔goal 件未装载/已卸/无 active 行三态同面〕）。
 */
export interface TodoGoalScope {
  readonly active: true;
  readonly activatedSeq: number | null;
  readonly needsWrite: boolean;
}

/**
 * 段约束执法：goal 段（scope 在场）→ deferred 必携合法 resume_when + completed
 * 二择一 + 词汇归属校验（resume_when 只随 deferred、follow_up/no_follow_up 只随
 * completed——条件词汇悬空即拒）；非 goal 段 → 扩字段申报即拒。违规 throw
 * GOAL_TODO_SCOPE（一次收集全部违规——模型可修一笔改对）。
 */
export function enforceTodoScope(items: readonly TodoItem[], scope: TodoGoalScope | undefined): void {
  const violations: string[] = [];
  for (const item of items) {
    if (scope === undefined) {
      // 非 goal 段：goal 段词汇不悬空（无复活复评机制，静默吞字段违诚实原则）
      const offenders: string[] = [];
      if (item.status === 'deferred') offenders.push('status=deferred');
      if (item.role !== undefined) offenders.push('role');
      if (item.taskClass !== undefined) offenders.push('task_class');
      if (item.resumeWhen !== undefined) offenders.push('resume_when');
      if (item.followUp !== undefined) offenders.push('follow_up');
      if (item.noFollowUp !== undefined) offenders.push('no_follow_up');
      if (item.gate !== undefined) offenders.push('gate');
      if (offenders.length > 0) {
        violations.push(
          `「${item.content}」携带 goal 段词汇（${offenders.join('、')}）——当前无进行中的目标，这些字段只在 goal active 期间可用`,
        );
      }
      continue;
    }
    // goal 段：deferred 必携合法 resume_when；非 deferred 携 resume_when = 悬空
    if (item.status === 'deferred') {
      if (item.resumeWhen === undefined) {
        violations.push(
          `「${item.content}」标记 deferred 但缺 resume_when（复活条件——after@<ISO> 或 after@+<n>[mhd]）`,
        );
      } else if (!isValidResumeWhen(item.resumeWhen)) {
        violations.push(
          `「${item.content}」resume_when 词形非法（${item.resumeWhen}——只收 after@<ISO> 或 after@+<n>[mhd]）`,
        );
      }
    } else if (item.resumeWhen !== undefined) {
      violations.push(`「${item.content}」非 deferred 项携带 resume_when（复活条件只随 deferred）`);
    }
    // goal 段：completed 强制后继二择一（防「完成即失联」）；非 completed 携 = 悬空
    if (item.status === 'completed') {
      const hasFollow = item.followUp !== undefined;
      const hasNone = item.noFollowUp === true;
      if (hasFollow === hasNone) {
        // 同真（两说矛盾）或同假（均缺）——二择一必须恰一
        violations.push(
          hasFollow
            ? `「${item.content}」同时携带 follow_up 与 no_follow_up（二择一）`
            : `「${item.content}」标记 completed 但缺后继申报（follow_up 描述后续工作 或 no_follow_up:true 明示无后继——二择一）`,
        );
      }
    } else if (item.followUp !== undefined || item.noFollowUp !== undefined) {
      violations.push(`「${item.content}」非 completed 项携带 follow_up / no_follow_up（后继申报只随 completed）`);
    }
  }
  if (violations.length > 0) {
    throw new AppError(GOAL_TODO_SCOPE, violations.join('\n'));
  }
}

/* ---------------- gates 验证器（T3-A——三源判据） ---------------- */

/** gate 失败结构化回执（kind + reason 税目 + 人读细节——GOAL_GATE_FAILED 载荷） */
export interface GateFailure {
  /** 失败项内容（回执定位） */
  readonly item: string;
  readonly kind: 'command' | 'files' | 'diagnostics';
  readonly reason: 'nonzero' | 'timeout' | 'malformed' | 'denied' | 'missing';
  /** 人读细节（退出码/缺失文件名/诊断条目——不读语义，只搬机制信号） */
  readonly detail: string;
}

/** command gate 走 exec 三段管道的注入面（chat 驱动 open 闭包装配——driverPipeline + bashDef） */
export type CommandGateRunner = (
  command: string,
  signal?: AbortSignal,
) => Promise<{ readonly exitCode?: number; readonly isError: boolean; readonly text: string }>;

/** diagnostics gate 的 lsp 查询注入面（组合根通道迟到注入——缺席时申报即拒） */
export type DiagnosticsGateQuery = (paths: readonly string[]) => Promise<
  | readonly {
      readonly path: string;
      readonly outcome: 'ok' | 'missing' | 'malformed';
      readonly note?: string;
      readonly errors: readonly { readonly line?: number; readonly message: string }[];
    }[]
  | undefined
>;

/** gates 执行依赖束（数据面闭包注入——纯函数可单测的关键） */
export interface TodoGateFaces {
  /** 工作区根（files gate 可读根 fence 的锚——fs 读面同款） */
  readonly workspaceRoot: string;
  /** command 验证命令执行面（三段管道全执法——守门/审批/沙箱/durable 照常） */
  readonly runCommand?: CommandGateRunner;
  /** diagnostics 查询面（lsp 件迟到注入；undefined = 面缺席申报即拒） */
  readonly queryDiagnostics?: DiagnosticsGateQuery;
  /** goal needsWrite 申报值（command gate 准入——申请→批准→守门同构） */
  readonly needsWrite: boolean;
}

/** command gate 超时帽（30s——骨架篇 §6.8 gates 条；经 bash timeoutMs 参数钳制） */
export const GATE_COMMAND_TIMEOUT_MS = 30_000;

/**
 * 申报期准入校验（add 时申报的 gate 声明先过机制门槛，不等到置 completed 才炸）：
 * - kind/spec 形状配对（command/diagnostics: string；files: string[]）→ 否则
 *   'malformed'；
 * - command gate 且 needsWrite 未申报 → 'denied'（模型自造命令免审批自跑是
 *   注入面——与 needsWrite「申请→批准→守门」同构）；
 * - diagnostics gate 且查询面缺席（lsp 件未装载/无服务器）→ 'missing'（冷读
 *   CR-12：fail-closed 非静默跳过）。
 */
export function declareGateFailure(
  gate: TodoGate,
  faces: Pick<TodoGateFaces, 'needsWrite' | 'runCommand' | 'queryDiagnostics'>,
): GateFailure | undefined {
  const malformed = (detail: string): GateFailure => ({ item: '', kind: gate.kind, reason: 'malformed', detail });
  if (gate.kind === 'files') {
    if (
      !Array.isArray(gate.spec) ||
      gate.spec.length === 0 ||
      gate.spec.some((p) => typeof p !== 'string' || p === '')
    ) {
      return malformed('files gate 的 spec 须为非空字符串清单');
    }
    return undefined;
  }
  if (gate.kind === 'command') {
    if (typeof gate.spec !== 'string' || gate.spec.trim() === '') {
      return malformed('command gate 的 spec 须为非空命令串');
    }
    if (!faces.needsWrite) {
      return {
        item: '',
        kind: 'command',
        reason: 'denied',
        detail:
          'command gate 仅在 goal 申报 needsWrite（写面开洞批准）后可用——模型自造命令免审批自跑是注入面；先 goal_set needsWrite:true',
      };
    }
    return faces.runCommand === undefined ? malformed('command 执行面缺席（驱动无 bash 工具域）') : undefined;
  }
  // diagnostics：单串或串清单均可（多文件验证合法——查询面收路径数组）
  const targets = Array.isArray(gate.spec) ? gate.spec : [gate.spec];
  if (targets.length === 0 || targets.some((p) => typeof p !== 'string' || p.trim() === '')) {
    return malformed('diagnostics gate 的 spec 须为非空文件串或其清单');
  }
  return faces.queryDiagnostics === undefined
    ? {
        item: '',
        kind: 'diagnostics',
        reason: 'missing',
        detail: 'diagnostics 查询面缺席（lsp 件未装载或无服务器配置）——fail-closed',
      }
    : undefined;
}

/**
 * files gate 验证器：清单内全部文件存在且非空；路径过 fs 读面同款可读根
 * fence（stat 前归一判 workspace 根内——模型申报路径的裸 stat 不得是无
 * fence 存在性 oracle，冷读 CR-20）。根外/缺文件/空文件 = 'missing'。
 */
async function runFilesGate(spec: readonly string[], workspaceRoot: string): Promise<GateFailure | undefined> {
  // 根与目标双规（fs 工具族 fence 同源模式）：目标 canonicalPath 解符号链，
  // 根也得同规——macOS tmpdir 的 /var → /private/var 符号链下单规根会把
  // 合法文件误判根外（realpathSync.native 逐组件解析，两规才在同一坐标系）
  const root = canonicalPath(workspaceRoot);
  for (const path of spec) {
    // 归一：相对路径锚工作区根，canonicalPath 解析符号链 + resolve 词法坍缩
    // （与 exec 工具 cwd 前缀判定同款双查——不依赖存在性的逃逸路径也得拦）
    const joined = path.startsWith('/') ? path : `${workspaceRoot}/${path}`;
    const resolved = resolve(canonicalPath(joined));
    if (!isInsideRoot(resolved, root)) {
      return {
        item: '',
        kind: 'files',
        reason: 'missing',
        detail: `路径在可读根外（${path} → ${resolved}，根 ${root}）`,
      };
    }
    try {
      const info = await stat(resolved);
      if (!info.isFile()) {
        return { item: '', kind: 'files', reason: 'missing', detail: `不是常规文件：${path}` };
      }
      if (info.size === 0) {
        return { item: '', kind: 'files', reason: 'missing', detail: `文件为空：${path}` };
      }
    } catch {
      return { item: '', kind: 'files', reason: 'missing', detail: `文件不存在：${path}（解析为 ${resolved}）` };
    }
  }
  return undefined;
}

/**
 * 验证期 gates 总装：items 内「置 completed 且带 gate」的项逐项同步验证——
 * 全过返回 undefined；任一失败返回首笔 GateFailure（fail-closed：置 completed
 * 被拒，todo/write 整笔不落账）。
 */
export async function runTodoGates(
  items: readonly TodoItem[],
  faces: TodoGateFaces,
  /** 调用侧取消信号（透传 command gate——用户中断时不留悬挂验证轮） */
  signal?: AbortSignal,
): Promise<GateFailure | undefined> {
  for (const item of items) {
    if (item.status !== 'completed' || item.gate === undefined) continue;
    const gate = item.gate;
    let failure: GateFailure | undefined;
    if (gate.kind === 'files') {
      failure = await runFilesGate(gate.spec as readonly string[], faces.workspaceRoot);
    } else if (gate.kind === 'command') {
      if (faces.runCommand === undefined) {
        // 执行面缺席（申报期准入常径已拦——此处兜底 fail-closed，不裸 TypeError）
        return {
          item: item.content,
          kind: 'command',
          reason: 'malformed',
          detail: 'command 执行面缺席（驱动无 bash 工具域）',
        };
      }
      // 走 exec 三段管道全执法（守门/审批/沙箱/durable 落账照常）——faces 注入
      // driverPipeline + bashDef 闭包；30s 帽经 bash timeoutMs 参数携带。
      // 管道两抛面在此分类：TOOL_TIMEOUT（超时树杀）/ TOOL_BLOCKED（守门拒）
      // 均是结构化 AppError——分类为 reason 后以 GOAL_GATE_FAILED 回执（验证器
      // 失败是 todo 执行段的预期态，不是 todo 工具自身的故障）
      let run: Awaited<ReturnType<CommandGateRunner>>;
      try {
        run = await faces.runCommand(gate.spec as string, signal);
      } catch (err) {
        const code = err instanceof AppError ? err.code : undefined;
        if (code === TOOL_TIMEOUT) {
          failure = {
            item: item.content,
            kind: 'command',
            reason: 'timeout',
            detail: `验证命令超时（>${GATE_COMMAND_TIMEOUT_MS}ms）：${gate.spec}`,
          };
        } else if (code === TOOL_BLOCKED) {
          failure = { item: item.content, kind: 'command', reason: 'denied', detail: describeError(err) };
        } else {
          failure = { item: item.content, kind: 'command', reason: 'malformed', detail: describeError(err) };
        }
        return failure;
      }
      const detail = run.text.split('\n').slice(0, 6).join('\n');
      // 拒绝族判定先于退出码：denial 结果文本带统一标记（[sandbox: file access
      // denied under …] / 升权审批被拒 / 升权审批已取消——safety/sandbox.ts 单源）
      if (run.isError && /升权审批被拒|审批已取消|sandbox:/.test(run.text)) {
        failure = { item: item.content, kind: 'command', reason: 'denied', detail };
      } else if (run.exitCode !== undefined && run.exitCode !== 0) {
        failure = { item: item.content, kind: 'command', reason: 'nonzero', detail };
      } else if (run.isError) {
        // 无退出码面的错误形态（spawn 失败等）——判据面畸形族
        failure = { item: item.content, kind: 'command', reason: 'malformed', detail };
      }
    } else {
      // diagnostics：分类原始结果面（ok/missing/malformed）+ error 级在场 → nonzero。
      // spec 单串归一为数组再送查询面（lsp 面收路径数组——字符串直送 .map 即炸）；
      // 查询面缺席（申报期常径已拦）兜底 fail-closed
      if (faces.queryDiagnostics === undefined) {
        return { item: item.content, kind: 'diagnostics', reason: 'missing', detail: 'diagnostics 查询面缺席' };
      }
      const targets = Array.isArray(gate.spec) ? gate.spec : [gate.spec];
      const files = await faces.queryDiagnostics(targets);
      if (files === undefined) {
        failure = { item: item.content, kind: 'diagnostics', reason: 'missing', detail: 'diagnostics 查询面缺席' };
      } else {
        for (const file of files) {
          if (file.outcome === 'missing') {
            failure = {
              item: item.content,
              kind: 'diagnostics',
              reason: 'missing',
              detail: `文件不在盘上：${file.path}`,
            };
            break;
          }
          if (file.outcome === 'malformed') {
            failure = {
              item: item.content,
              kind: 'diagnostics',
              reason: 'malformed',
              detail: `${file.path}：${file.note ?? '判据面不可用'}`,
            };
            break;
          }
          if (file.errors.length > 0) {
            const lines = file.errors.slice(0, 5).map((e) => `${file.path}:${e.line ?? '?'} ${e.message}`);
            failure = { item: item.content, kind: 'diagnostics', reason: 'nonzero', detail: lines.join('\n') };
            break;
          }
        }
      }
    }
    if (failure !== undefined) {
      return { ...failure, item: failure.item === '' ? item.content : failure.item };
    }
  }
  return undefined;
}

/** GateFailure → GOAL_GATE_FAILED 回执文本（结构化前缀 kind=… reason=… 机器可parse） */
export function renderGateFailure(failure: GateFailure): string {
  return `goal gate 未过：kind=${failure.kind} reason=${failure.reason}（项「${failure.item}」）\n${failure.detail}`;
}
