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
import type { AllowlistEntry, SandboxMode, SandboxService } from '../safety/index.js';
import {
  commandStem,
  escalationHintMarker,
  matchAllowlist,
  requestEscalation,
  sandboxDenialMarker,
  validateEscalationArgs,
} from '../safety/index.js';
import { classifyDenials, runArgv, type CommandProcessLog } from './spawn.js';
import { buildChildEnv } from './env.js';

export type { CommandProcessLog };
import { resolveBash } from './bash-path.js';

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
  /**
   * 跨会话 allowlist（§8.4 增补 2 落码形态③）：bash 族的唯一消费点在升权
   * 裁决前查表（「始终允许」词干条目命中 → workspace-write 目标免问直接升档；
   * danger 目标恒问）。装配注入活数组引用，TTL 过期由引擎逐调用判定。
   */
  readonly allowlist?: readonly AllowlistEntry[];
  /**
   * 宿主主动注入值取值器（契约篇 §1.2 宿主主动注入通道，2026-08-31 第四十四批）：
   * bash 按会话装配（chat 件 open() 闭包传本会话 sessionId 的 hostInjectRecord）；
   * 逐调用取最新；undefined = 该装配形态不注入（测试缺省）。
   */
  readonly hostEnv?: () => Record<string, string>;
  /**
   * 命令进程登记簿（契约篇 §6.6 子进程治理条 exec 腿，2026-08-29 critic #1）：
   * spawn 即登记、净退即删——宿主猝死后由启动期孤儿清扫认领树杀。组合根经
   * chat 件 deps 注入（exec 结构上不见 mcp，killTree 闭包同款先例）。
   */
  readonly commandLog?: CommandProcessLog;
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

      /* ---- 升权裁决（§7.4 + §8.4 增补 2：成对校验 → allowlist 免问 → 审批 → allowed-once 只授予当次） ---- */
      let effective: SandboxMode = opts.mode();
      if (req.sandbox_permissions !== undefined || req.justification !== undefined) {
        const valid = validateEscalationArgs({
          current: effective,
          sandboxPermissions: req.sandbox_permissions,
          justification: req.justification,
        });
        // 「始终允许」免问复查（§8.4 增补 2 落码形态②③）：bash 族 allowlist 的
        // 唯一消费点在此——workspace-write 目标且命令词干命中条目即免审批直接
        // 升档（advisory：只影响问不问，confine/执行段照走）。danger-full-access
        // 是 safetyLevel 高位 v1 刻度，allowlist 免问不适用（落码形态②恒问边界）。
        const allowlistHit =
          valid.target === 'workspace-write' &&
          opts.allowlist !== undefined &&
          matchAllowlist(opts.allowlist, { tool: 'bash', bashCommand: req.command }, Date.now()) !== undefined;
        if (allowlistHit) {
          effective = valid.target; // 词干条目授权：免审批升档仅本次（allowed-once 语义同源）
        } else {
          // 推荐规则草案（落码形态①）：bash 草案 = 剥壳词干，仅 workspace-write
          // 目标携带；剥不出干净词干（管道/flag/引号…）= 无草案，选项不呈现
          const stem = valid.target === 'workspace-write' ? commandStem(req.command) : undefined;
          const outcome = await requestEscalation(opts.approval, {
            ...valid,
            current: effective,
            toolName: 'bash',
            toolCallId: tctx.toolCallId,
            // interrupt 小刀升权路填点：当轮 run 取消信号随升权载荷透传——
            // interrupt/quit 即撤销在身升权提问（ask 不再永挂 run）
            ...(tctx.signal !== undefined ? { signal: tctx.signal } : {}),
            ...(stem !== undefined ? { suggestedEntry: { tool: 'bash', pattern: stem } } : {}),
          });
          if (outcome !== 'allowed-once') {
            // cancelled 档是打断非拒绝（interrupt 小刀冷读 F6）：去「被拒」与
            // 升权重试引导——run 已 abort 时模型看不见（loop break 在先），收
            // durable 审计面与 resume 回放语境的诚实
            const sandbox: SandboxMeta = { mode: effective, denied: [], enforcement: 'none' };
            const text =
              outcome === 'cancelled'
                ? `${sandboxDenialMarker(effective)} 升权审批已取消（run 已打断）。`
                : `${sandboxDenialMarker(effective)} 升权审批被拒（${outcome}）。${escalationHintMarker()}`;
            return {
              content: [{ type: 'text', text }],
              isError: true,
              details: { sandbox },
            };
          }
          effective = valid.target; // allowed-once：目标档仅本次调用生效
        }
      }

      /* ---- 沙箱包装（danger 透传；受限档 confine；fail-closed 不裸跑） ---- */
      // bash 可执行发现序四级（骨架篇 §7.6——挖矿 B11 缺口③：裸名 'bash' 在
      // win32 撞 System32 WSL 启动器陷阱）；解析在 confine 之前（首参定型后
      // 再包装）；全序皆空 = EXEC_SPAWN_FAILED fail-loud 列已探测位
      const baseArgv = [resolveBash(), '-c', req.command];
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
      // 宿主主动注入在场 = 显式合成 env（白名单→注入→（无表）同层序单源
      // buildChildEnv；undefined 注入装配 = 不传 env 走 spawn 缺省，行为不变）
      const hostInject = opts.hostEnv?.();
      const run = await runArgv(argv, {
        cwd,
        timeoutMs: clamped,
        signal: tctx.signal,
        ...(hostInject !== undefined ? { env: buildChildEnv(process.env, undefined, hostInject) } : {}),
        // 命令进程登记簿透传（宿主猝死孤儿治理——见 BashToolOptions.commandLog 注）
        ...(opts.commandLog !== undefined ? { commandLog: opts.commandLog } : {}),
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
      // 非静默纪律（骨架篇 §7.6 输出编码）：非 UTF-8 终判的流在流段落开头加
      // 标注行——「标注的转码」不是「静默错猜」（details 面经 ...run 展开自带）
      const streamNote = (stream: 'stdout' | 'stderr'): string => {
        const enc = run.outputEncoding[stream];
        if (enc === 'utf-8') return '';
        return enc.endsWith('-lossy')
          ? `[${stream} 按 ${enc.slice(0, -'-lossy'.length)} 有损解码——存在无法按该编码解释的字节]`
          : `[${stream} 按本地编码 ${enc} 转码解码]`;
      };
      const lines: string[] = [];
      if (clampedNote !== '') lines.push(clampedNote);
      lines.push(run.signal !== undefined ? `signal: ${run.signal}` : `exit code: ${run.exitCode}`);
      if (run.stdout !== '') {
        lines.push('', '--- stdout ---');
        const note = streamNote('stdout');
        if (note !== '') lines.push(note);
        lines.push(run.stdout);
      }
      if (run.stderr !== '') {
        lines.push('', '--- stderr ---');
        const note = streamNote('stderr');
        if (note !== '') lines.push(note);
        lines.push(run.stderr);
      }
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
