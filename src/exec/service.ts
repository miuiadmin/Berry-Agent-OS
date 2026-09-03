/**
 * L4 exec — ctx.exec 服务（骨架篇 §9.3 定稿落码）。
 *
 * 服务面与模型工具面刻意不对称（§9.3）：原语侧宽（stdin/env 表/abort 信号/
 * 自管超时——宿主侧服务是可信调用方），bash 工具侧窄（无 stdin、无 env——
 * 堵模型面走私）。两面向下共用同一条三段管道与同一个 spawn 管道：
 *
 * - **同一条三段 waterfall**：服务内部合成 ToolDefinition（内部名 `exec`，
 *   **不注册进注册表**——不进模型词汇表，模型永不可见）+ 内部生成
 *   toolCallId，直接调 pipeline 执行——守门/落账/后处理对服务调用同样生效
 *   （gate/decision durable 归发起方会话，接线在管道闭包内已就位）；
 * - **同一个 spawn 管道**：失败二分/进程组纪律/输出预算对两面对齐——
 *   服务侧 spawn 的 `git`/`node` 与模型侧跑的 `bash` 行为无两套分叉。
 */

import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import type { ExecResult, ExecService } from '../contracts/exec.js';
import type { AgentToolResult, ToolDefinition } from '../contracts/tools.js';
import type { Context } from '../context/types.js';
import { chainCallers } from '../context/chain.js';

/**
 * 行代执行强制预算缺省（毫秒）——契约篇 §1.7 第十一轮遗漏大扫 20260904-b
 * 增补第 2 条。exec 不能 import bridge（拓扑白名单），故本地常量与
 * bridge/session.ts 的 SVC_PROXY_TIMEOUT_MS 同值同族（60s）——两处同批立法，
 * 改值须同步（同族缺省注记，非引用关系）。
 */
const ROW_EXEC_TIMEOUT_DEFAULT_MS = 60_000;
import type { ToolPipelineExecutor } from '../tools/pipeline.js';
import { intersectRoots } from '../safety/roots.js';
import type { SandboxMode, SandboxService } from '../safety/index.js';
import { classifyDenials, runArgv, type CommandProcessLog, type RunResult } from './spawn.js';
import { buildChildEnv } from './env.js';

/** 服务装配选项（app 组合根注入） */
export interface ExecServiceOptions {
  /** 工具管道（同一条三段 waterfall——服务调用不旁路守门与落账） */
  readonly pipeline: ToolPipelineExecutor;
  /** 沙箱服务（confine 包装；fail-closed 不裸跑） */
  readonly sandbox: SandboxService;
  /** 当前生效档位取值器（逐调用取最新） */
  readonly mode: () => SandboxMode;
  /** 会话工作区根（canonical 绝对路径） */
  readonly workspaceRoot: string;
  /**
   * 按 caller-chain 调用方推导行收窄白名单（R1 P0-4，契约篇 §1.7 增补 2c
   * R1 注记 2026-08-29）：入参 = caller-chain 读出的行 id（非行帧 = undefined）；
   * 返回 undefined = 不收窄（模型面/宿主直调/非 external 行——维持会话档
   * 现行为）；返回根列表 = 该行有效白名单（基线 ∩ 行声明，单源住
   * safety/roots 的 externalEffectiveRoots），作为 confine 的
   * writableRoots 显式覆盖面——「OS 沙箱罩后代」对间接子进程的执法通道。
   * 组合根注入（exec 不能 import app——拓扑白名单），注入面为闭包。
   */
  readonly confinementFor?: (caller: string | undefined) => readonly string[] | undefined;
  /**
   * 宿主主动注入值取值器（契约篇 §1.2 宿主主动注入通道，2026-08-31 第四十四批）：
   * 逐调用取最新（会话语境可变——前台聚焦/链帧随调用方变）。组合根注入，
   * 返回 hostInjectRecord 产物；undefined = 该装配形态不注入（测试缺省）。
   */
  readonly hostEnv?: () => Record<string, string>;
  /**
   * 命令进程登记簿（契约篇 §6.6 子进程治理条 exec 腿，2026-08-29 critic #1）：
   * spawn 即登记、净退即删——宿主猝死后由启动期孤儿清扫认领树杀。组合根注
   * mcp ChildRegistry 适配器（exec 结构上不见 mcp，killTree 闭包同款先例）。
   */
  readonly commandLog?: CommandProcessLog;
  /**
   * 行代执行强制预算覆写（毫秒，缺省 60s——契约篇 §1.7 第十一轮遗漏大扫
   * 20260904-b 增补第 2 条）：caller 链有行帧（svc-invoke/tool-run 过桥的代
   * 执行）且调用方未显式给 timeoutMs 时，内部合成 def 的管道预算上限。测试
   * 专用注入面（60s 缺省在测试形态不可观察）。
   */
  readonly rowExecTimeoutMs?: number;
}

/**
 * 内部合成 def 的参数 schema（服务面载荷——env 表刻意不入 schema：
 * env 是宿主侧结构化入参，在管道之前已合成完毕，不经守门 mutate 面）。
 */
const INTERNAL_EXEC_PARAMETERS = Type.Object({
  command: Type.String(),
  args: Type.Array(Type.String()),
  cwd: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
  stdin: Type.Optional(Type.String()),
});

/**
 * caller 链全栈行收窄推导（R1 复盘批二栈化——契约篇 §1.7 第 11b 条）：
 * 栈上每个有行声明的帧各自查注入面取有效白名单，多帧命中取交集（窄者胜
 * ——链上任一行的声明都约束本执行）。全栈无命中 = undefined（不收窄，
 * 会话档现行为）。注入面签名保持单帧（组合根闭包零改动），栈扫描归本
 * 消费面——「宿主内代执行写面」统一闸的两消费面（exec 服务 / 子代理
 * 工厂自建 fs）共用本语义。
 */
function rowConfinement(
  confinementFor: ((caller: string | undefined) => readonly string[] | undefined) | undefined,
): readonly string[] | undefined {
  if (confinementFor === undefined) return undefined;
  const rowLists = chainCallers()
    .map((caller) => confinementFor(caller))
    .filter((roots): roots is readonly string[] => roots !== undefined);
  if (rowLists.length === 0) return undefined;
  return intersectRoots(rowLists);
}

/** RunResult（裸进程结果）+ 沙箱元数据 → ExecResult（服务面结果） */
function toExecResult(run: RunResult, sandbox: ExecResult['sandbox']): ExecResult {
  return {
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    truncated: run.truncated,
    durationMs: run.durationMs,
    outputEncoding: run.outputEncoding,
    ...(run.signal !== undefined ? { signal: run.signal } : {}),
    sandbox,
  };
}

/**
 * 注册 ctx.exec 服务（组合根 ⑦区调用；ctx.get<ExecService>('exec') 取用）。
 * 服务与驱动同件同生命周期——本函数即 provide 点，无游离态。
 */
export function registerExecService(ctx: Context, opts: ExecServiceOptions): ExecService {
  const service: ExecService = {
    async exec(cmd, args, callOpts = {}): Promise<ExecResult> {
      // env 先合成（EXEC_ENV_FORBIDDEN 在此响亮拒——机器执法先于守门段）；
      // 宿主注入在场时无表也合成（注入层恒生效——白名单→注入→变更表同层序，
      // 两消费面单源 buildChildEnv；无注入无表 = env undefined 走 spawn 缺省）
      const hostInject = opts.hostEnv?.();
      const env =
        callOpts.env !== undefined || hostInject !== undefined
          ? buildChildEnv(process.env, callOpts.env, hostInject)
          : undefined;
      // 真值捕获口：execute 内写入——管道后处理段可改写 result 对象，但
      // 服务面返回值以本闭包捕获为准（details 面不依赖 post 段不重写）
      let captured: ExecResult | undefined;

      // 行代执行强制预算（契约篇 §1.7 第十一轮遗漏大扫 20260904-b 增补第 2
      // 条）：caller 链有行帧（chainCallers() 非空——svc-invoke/tool-run 过桥
      // 的代执行，含 worker-threads 行：confinementFor 对其返回 undefined 不可
      // 作行判据，行帧在场性本身才是判据）且调用方未显式给 timeoutMs 时，合成
      // def 由 0（不设限）改强制行预算——域侧真实现挂死即宿主侧进程永活的对
      // 端形态，无预算 = 敌意应用可借 exec 腿 spawn 永活进程。宿主 origin（链
      // 无行帧）维持原语侧超时自治不变（「timeoutMs 由调用方显式给」的宿主
      // 信任前提不外溢到分域行）；调用方显式给 timeoutMs 的行帧调用照旧走
      // req.timeoutMs 自治（显式值优先于强制缺省——下方 execute 内 req 路不变）。
      const rowOriginated = chainCallers().length > 0;
      const forcedTimeoutMs =
        rowOriginated && callOpts.timeoutMs === undefined ? (opts.rowExecTimeoutMs ?? ROW_EXEC_TIMEOUT_DEFAULT_MS) : 0;
      // 内部合成 def：内部名 exec 不注册（模型词汇表不可见）；预算 0 = 管道
      // 不设限（原语侧超时自治——timeoutMs 由调用方显式给，runArgv 自计时）；
      // 行帧且未显式给 = 强制行预算（上段）
      const def: ToolDefinition = {
        name: 'exec',
        label: '（内部）子进程执行',
        effect: 'write',
        timeoutMs: forcedTimeoutMs,
        description: '内部合成：ctx.exec 服务原语（不进模型词汇表）',
        parameters: INTERNAL_EXEC_PARAMETERS,
        execute: async (input, tctx): Promise<AgentToolResult> => {
          const req = input as {
            command: string;
            args: string[];
            cwd?: string;
            timeoutMs?: number;
            stdin?: string;
          };
          // 沙箱包装（danger 透传；受限档 confine；fail-closed 不裸跑）
          const mode = opts.mode();
          const baseArgv = [req.command, ...req.args] as const;
          let argv: string[];
          let enforcement: ExecResult['sandbox']['enforcement'];
          let denialSignatures: readonly string[] = [];
          if (mode === 'danger-full-access') {
            argv = [...baseArgv];
            enforcement = 'none';
          } else {
            // 行收窄查询（R1 P0-4 → R1 复盘批二栈化）：经 svc-invoke/tool-run
            // 进宿主的分域行调用按 caller 链**全栈**查行有效白名单、多帧命中
            // 取交集（窄者胜——借道不丢约束；委派链上工具执行段按注册归属
            // 重包后外层分域行帧经 chainCallers() 仍可追祖）。非行帧（模型面/
            // 宿主直调）或注入面缺席 = undefined = 会话档现行为。danger 档
            // 透传不 confine（会话级豁免优先——行收窄只发生在受限档，不另造
            // 路径）。**read-only 会话档注记（契约篇 §1.7 第 11b 条裁定）**：
            // 行帧执法面 = 行基线非会话档投影——会话 read-only 下行帧间接
            // 子进程仍按行基线可写（与域本体 PM 旗同权：域后台不受宿主会话
            // 档约束——会话档管「会话上下文里的写」，行帧管「行代执行的写」，
            // 两轴正交）。
            const rowRoots = rowConfinement(opts.confinementFor);
            const confined = opts.sandbox.confine(baseArgv, {
              mode,
              workspaceRoot: opts.workspaceRoot,
              ...(rowRoots !== undefined ? { writableRoots: rowRoots } : {}),
            });
            argv = confined.argv;
            enforcement = confined.enforcement;
            denialSignatures = confined.denialSignatures;
          }

          // 取消信号经管道 tctx 传入（调用方 signal 即管道第 4 参——单一通道）
          const run = await runArgv(argv, {
            cwd: req.cwd,
            timeoutMs: req.timeoutMs,
            signal: tctx.signal,
            stdin: req.stdin,
            env,
            // 命令进程登记簿透传（宿主猝死孤儿治理——见 ExecServiceOptions.commandLog 注）
            ...(opts.commandLog !== undefined ? { commandLog: opts.commandLog } : {}),
            ...(callOpts.onOutput !== undefined ? { onOutput: callOpts.onOutput } : {}),
          });
          const denied = classifyDenials(run.stderr, denialSignatures);
          const execResult = toExecResult(run, { mode, denied, enforcement });
          captured = execResult;
          // 管道结果面（文本形态供落账/监听者看；结构化真值走闭包捕获）
          return {
            content: [{ type: 'text', text: JSON.stringify(execResult) }],
            isError: run.exitCode !== 0 || denied.length > 0,
            details: execResult,
          };
        },
      };

      // 管道载荷（env 已前置合成，闭包带入——不经 schema/守门 mutate 面）
      const pipelineArgs: Record<string, unknown> = {
        command: cmd,
        args: [...args],
        ...(callOpts.cwd !== undefined ? { cwd: callOpts.cwd } : {}),
        ...(callOpts.timeoutMs !== undefined ? { timeoutMs: callOpts.timeoutMs } : {}),
        ...(callOpts.stdin !== undefined ? { stdin: callOpts.stdin } : {}),
      };

      // 内部 toolCallId（可追溯性：durable gate/decision 落账需要稳定 id）；
      // 守门 block / 超时 / 校验失败一律 throw AppError——原语调用方是宿主侧
      // 代码，异常面比文本面更有用（与模型工具面的结构化拒绝刻意不对称）
      const toolCallId = `exec-${randomUUID()}`;
      // origin='service'（P1-2 增补 7③）：宿主服务面复入的显式判别词——守门行
      // 按面别分叉不靠合成名 'exec' 嗅探
      await opts.pipeline(def, toolCallId, pipelineArgs, callOpts.signal, undefined, 'service');
      return captured!; // execute 已跑即必写（block/异常路径走 throw 不会到这）
    },
  };

  ctx.provide('exec', service);
  return service;
}
