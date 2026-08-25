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
import type { ExecEnvTable, ExecOptions, ExecResult, ExecService } from '../contracts/exec.js';
import type { AgentToolResult, ToolDefinition } from '../contracts/tools.js';
import type { Context } from '../context/types.js';
import type { ToolPipelineExecutor } from '../tools/pipeline.js';
import type { SandboxMode, SandboxService } from '../safety/index.js';
import { classifyDenials, runArgv, type RunResult } from './spawn.js';
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

/** RunResult（裸进程结果）+ 沙箱元数据 → ExecResult（服务面结果） */
function toExecResult(run: RunResult, sandbox: ExecResult['sandbox']): ExecResult {
  return {
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    truncated: run.truncated,
    durationMs: run.durationMs,
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
      // env 表先合成（EXEC_ENV_FORBIDDEN 在此响亮拒——机器执法先于守门段）
      const env = callOpts.env !== undefined ? buildChildEnv(process.env, callOpts.env) : undefined;
      // 真值捕获口：execute 内写入——管道后处理段可改写 result 对象，但
      // 服务面返回值以本闭包捕获为准（details 面不依赖 post 段不重写）
      let captured: ExecResult | undefined;

      // 内部合成 def：内部名 exec 不注册（模型词汇表不可见）；预算 0 = 管道
      // 不设限（原语侧超时自治——timeoutMs 由调用方显式给，runArgv 自计时）
      const def: ToolDefinition = {
        name: 'exec',
        label: '（内部）子进程执行',
        effect: 'write',
        timeoutMs: 0,
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
            const confined = opts.sandbox.confine(baseArgv, { mode, workspaceRoot: opts.workspaceRoot });
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
      await opts.pipeline(def, toolCallId, pipelineArgs, callOpts.signal);
      return captured!; // execute 已跑即必写（block/异常路径走 throw 不会到这）
    },
  };

  ctx.provide('exec', service);
  return service;
}
