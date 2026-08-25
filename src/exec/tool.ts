/**
 * L4 exec — bash 工具件（Ring 1 七件套第三件；骨架篇 §7.6 参数面 v1 定稿落码）。
 *
 * 参数面刻意收窄（相对 ctx.exec 原语侧）：**无 stdin**（模型工具侧无 stdin
 * 数据源）、**无 env 参数**（子进程环境统一走 spawn env 白名单——堵模型面
 * 走私 env）、无 background（后台 = ctx.jobs kind='process' 词汇已埋，后台刀
 * M2+）。升权两参数 sandbox_permissions/justification = §7.4 成对非空词汇——
 * read-only 拒写后 hint 教模型带此对重试；**bash 即升权词汇首个消费者**
 * （requestEscalation 落 safety 后零消费者的接线债本批收口）。
 *
 * 超时路线（§7.6 冷读 blocker 钉死）：工具自治超时——def 级管道预算旁路
 * （置最高护栏值 600s），execute 内自计时，超时 killpg 树杀抛 TOOL_TIMEOUT。
 *
 * effect 恒显式 'write'：只读命令判定 v1 走静态 effect 元数据（CC 式动态
 * 命令解析判定挂账；registry 缺省 'write' fail-closed，本件只是显式化）。
 */

import { Type } from 'typebox';
import { resolve } from 'node:path';
import { AppError, TOOL_ARGUMENTS_INVALID } from '../contracts/errors.js';
import type { ToolDefinition, AgentToolResult } from '../contracts/tools.js';
import type { SandboxMeta } from '../contracts/exec.js';
import { canonicalPath, isInsideRoot } from '../safety/roots.js';
import type { ApprovalService } from '../safety/approval.js';
import type { SandboxMode, SandboxService } from '../safety/index.js';
import {
  escalationHintMarker,
  requestEscalation,
  sandboxDenialMarker,
  validateEscalationArgs,
} from '../safety/index.js';
import { classifyDenials, runArgv } from './spawn.js';

/** 超时缺省（毫秒）——骨架篇 §7.6 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 超时上限（毫秒）——同条拍板：超上限钳制到上限并在结果开头标注 */
const MAX_TIMEOUT_MS = 600_000;

/** bash 工具件选项（app 装配层注入——与 fs/检索族同风格） */
export interface BashToolOptions {
  /** 沙箱服务（confine 纯包装；fail-closed：无后端抛 SANDBOX_UNAVAILABLE） */
  readonly sandbox: SandboxService;
  /** 审批服务（升权 allowed-once 的裁决面——§7.4 成对非空词汇的弹窗端） */
  readonly approval: ApprovalService;
  /** 当前生效档位取值器（三级解析产物；逐调用取最新） */
  readonly mode: () => SandboxMode;
  /** 会话工作区根（canonical 绝对路径——cwd 前缀判定锚点） */
  readonly workspaceRoot: string;
}

/**
 * 组装 bash 工具件（与 fs/检索族同装配点并列注册——双装配点先例）。
 * 子代理 toolFilter 名单机制自动纳管。
 */
export function createBashTool(opts: BashToolOptions): ToolDefinition {
  const workspaceRoot = canonicalPath(opts.workspaceRoot);

  return {
    name: 'bash',
    label: '执行命令',
    effect: 'write', // 恒显式（§7.6）——只读命令判定 v1 走静态元数据
    // def 级管道预算置最高护栏值：bash 自治超时（execute 内自计时 + 树杀），
    // 管道预算永不先于内部超时触发（内部已钳 ≤ 600s）
    timeoutMs: MAX_TIMEOUT_MS,
    description: [
      '在 shell 中执行一条 bash 命令（一次性执行，无交互 stdin；长任务建议后台化或分解）。',
      '命令经当前沙箱档位包装执行：读类命令通常不受限；写类命令受可写根约束，被拒时结果会带 [sandbox: …] 标记与升权指引。',
      'cwd 须在工作区内；timeoutMs 缺省 120 秒、上限 600 秒（超上限自动钳制）。',
    ].join(''),
    parameters: Type.Object({
      command: Type.String({ description: '要执行的 bash 命令（`bash -c` 形态执行）' }),
      timeoutMs: Type.Optional(
        Type.Number({ minimum: 1, description: '超时毫秒（缺省 120000，上限 600000——超上限钳制）' }),
      ),
      cwd: Type.Optional(Type.String({ description: '工作目录（须在工作区内；缺省工作区根）' })),
      // 升权两参数（§7.4 成对非空词汇——基于真实 denial 发起，不许投机）
      sandbox_permissions: Type.Optional(
        Type.String({
          description:
            '升权目标档（workspace-write 或 danger-full-access）——须与 justification 成对提供，仅在命令被沙箱拒绝后基于真实拒绝发起',
        }),
      ),
      justification: Type.Optional(Type.String({ description: '升权理由（与 sandbox_permissions 成对提供）' })),
    }),
    execute: async (args, tctx): Promise<AgentToolResult> => {
      const req = args as {
        command: string;
        timeoutMs?: number;
        cwd?: string;
        sandbox_permissions?: string;
        justification?: string;
      };

      /* ---- cwd 前缀判定（§7.6：canonical 化后须落 workspaceRoot 内） ---- */
      let cwd: string | undefined;
      if (req.cwd !== undefined) {
        const joined = req.cwd.startsWith('/') ? req.cwd : `${workspaceRoot}/${req.cwd}`;
        // 双查：canonicalPath 解析符号链（路径不存在时原样返回）；resolve 词法
        // 坍缩 `..`（不依赖存在性）——只查前者时 `sub/../../outside` 这类不存在的
        // 逃逸路径会以未坍缩原串过前缀判定（spawn 才以 ENOENT 迟到失败）
        const resolved = canonicalPath(joined);
        const lexical = resolve(joined);
        if (!isInsideRoot(lexical, workspaceRoot) || !isInsideRoot(resolved, workspaceRoot)) {
          // 参数可修复的调用方错误——结构化拒绝并给足定位信息（不越权默默改写）
          throw new AppError(
            TOOL_ARGUMENTS_INVALID,
            `cwd 须在工作区内：${req.cwd}（解析为 ${resolved}，工作区根 ${workspaceRoot}）`,
          );
        }
        cwd = resolved;
      }

      /* ---- 超时钳制（缺省 120s / 上限 600s，钳制在结果开头标注） ---- */
      const requested = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const clamped = Math.min(requested, MAX_TIMEOUT_MS);
      const clampedNote = requested > MAX_TIMEOUT_MS ? `[注：timeoutMs 超上限，已钳制到 ${MAX_TIMEOUT_MS}ms]` : '';

      /* ---- 升权裁决（§7.4：成对校验 → 审批 → allowed-once 只授予当次） ---- */
      let effective: SandboxMode = opts.mode();
      if (req.sandbox_permissions !== undefined || req.justification !== undefined) {
        const valid = validateEscalationArgs({
          current: effective,
          sandboxPermissions: req.sandbox_permissions,
          justification: req.justification,
        });
        const outcome = await requestEscalation(opts.approval, {
          ...valid,
          current: effective,
          toolName: 'bash',
          toolCallId: tctx.toolCallId,
        });
        if (outcome !== 'allowed-once') {
          // 拒绝/取消/无人应答：统一标记 + 同回合升权提示（§7.4 统一文案）
          const sandbox: SandboxMeta = { mode: effective, denied: [], enforcement: 'none' };
          return {
            content: [
              {
                type: 'text',
                text: `${sandboxDenialMarker(effective)} 升权审批被拒（${outcome}）。${escalationHintMarker()}`,
              },
            ],
            isError: true,
            details: { sandbox },
          };
        }
        effective = valid.target; // allowed-once：目标档仅本次调用生效
      }

      /* ---- 沙箱包装（danger 透传；受限档 confine；fail-closed 不裸跑） ---- */
      const baseArgv = ['bash', '-c', req.command] as const;
      let argv: string[];
      let enforcement: SandboxMeta['enforcement'];
      let denialSignatures: readonly string[] = [];
      if (effective === 'danger-full-access') {
        argv = [...baseArgv];
        enforcement = 'none';
      } else {
        const confined = opts.sandbox.confine(baseArgv, { mode: effective, workspaceRoot });
        argv = confined.argv;
        enforcement = confined.enforcement;
        denialSignatures = confined.denialSignatures;
      }

      /* ---- 自治执行（超时树杀抛 TOOL_TIMEOUT；流式增量 onUpdate 推 TUI） ---- */
      const run = await runArgv(argv, {
        cwd,
        timeoutMs: clamped,
        signal: tctx.signal,
        onOutput:
          tctx.onUpdate !== undefined
            ? (chunk) => {
                tctx.onUpdate!({ content: [{ type: 'text', text: `[${chunk.stream}] ${chunk.text}` }] });
              }
            : undefined,
      });

      /* ---- 结果组装（denied 分类 + 统一标记；退出非零 isError） ---- */
      const denied = classifyDenials(run.stderr, denialSignatures);
      const sandbox: SandboxMeta = { mode: effective, denied, enforcement };
      const lines: string[] = [];
      if (clampedNote !== '') lines.push(clampedNote);
      lines.push(run.signal !== undefined ? `signal: ${run.signal}` : `exit code: ${run.exitCode}`);
      if (run.stdout !== '') lines.push('', '--- stdout ---', run.stdout);
      if (run.stderr !== '') lines.push('', '--- stderr ---', run.stderr);
      if (run.truncated) lines.push('', '（输出超出 60 KiB 预算已保尾截断——tail 可见，head 已弃）');
      if (denied.length > 0) {
        lines.push(
          '',
          `${sandboxDenialMarker(effective)}（命中沙箱拒绝特征：${denied.join('；')}）`,
          escalationHintMarker(),
        );
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: run.exitCode !== 0 || denied.length > 0,
        details: { ...run, sandbox },
      };
    },
  };
}
