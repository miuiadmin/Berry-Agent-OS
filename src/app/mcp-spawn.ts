/**
 * L5 app — MCP 服务器子进程 spawn 组装（契约篇 §6.6 冷读 #1 裁决 + OS 沙箱层
 * 升格落码 2026-08-29）。
 *
 * spawn/kill 组装上提组合根：mcp 件经闭包收 spawnServer/killTree，结构上
 * 不见 exec/safety（内核篇席 14 边表 mcp = [contracts, context]——本文件是
 * exec/safety 与 mcp 之间唯一的组合根缝）。
 *
 * 组装纪律（契约篇 §6.6 transport/子进程治理/OS 沙箱层升格条）：
 * - **OS 层 confine 现役**（内核篇分层信任句式④——「exec 罩了、MCP 裸起」
 *   分叉已修死）：spawn argv 经 sandbox.confine 包装（seatbelt/bwrap，固定
 *   workspace-write 档 + writableRoots=[dataDir, workspace]，从全盘可写严格
 *   收窄；v1 不开 per-server 旋钮）；首 spawn 前探测后端链一次——空链或
 *   probe 失败 reject SANDBOX_UNAVAILABLE fail-closed（服务器绝不裸起），
 *   走 MCP_CONNECT_FAILED 降级不阻启动现律；win32 零后端同貌（无逃生门，
 *   与 exec confine 同律——有服务器配置即起不来，如实 warn）；
 * - env = buildChildEnv 白名单（deny-by-default）+ config.env set 显式层
 *   （用户声明的键值直传——服务器凭证走这里，不经宿主翻译）；env 层与
 *   OS 层是叠加执法非替代（PM 中层管 Node 内、OS 层管进程全行为）；
 * - detached（POSIX）建进程组——killTree 树杀的前提（与 exec spawn 管道同纪律）；
 * - cwd 钉死 dataDir——防随会话漂移（服务器相对路径资源有稳定锚点）；
 * - stdio 三管全 pipe（行帧 JSON-RPC 走 stdin/stdout，stderr 进诊断日志）。
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { AppError, SANDBOX_UNAVAILABLE } from '../contracts/errors.js';
import { buildChildEnv } from '../exec/index.js';
import type { ExecEnvTable } from '../contracts/exec.js';
import type { McpServerConfig } from '../mcp/index.js';
import type { SpawnedChild } from '../mcp/index.js';
import type { SandboxService } from '../safety/index.js';

/** 功能性探测超时（毫秒）——与 bridge-fleet ensureOsLayer 同值同义（真跑一次
 * 包装不该超过这个时长，超过视为后端不可用；sandbox.ts 同名常量不导出故本地声明） */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * 根归一（realpath 防 macOS /var ↔ /private/var 前缀漂移——seatbelt subpath
 * 按字面匹配，路径与子进程运行时不同形即静默失配；external 域 realize 同坑）。
 * 不存在路径原样保留：dataDir 由装配建好、workspace 调用方给定，两者在场是
 * 装配期不变量——ENOTSUP/跨设备等异常形态交 confine 后续层如实报错。
 */
function realizeRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * 构造 spawnServer 闭包（builtins 注入 mcp 件）。
 *
 * @param dataDir 数据目录（cwd 钉死锚点 = 登记簿同级根 + 可写根之一）
 * @param sandbox 沙箱服务（confine 包装 + 后端链探测；assembly ⑥b 同源实例）
 * @param workspace 工作区根（可写根之一——filesystem 服务器主用例）
 * @returns (config) => Promise<SpawnedChild>——client 层 connectMcpServer 消费；
 *   后端链不可用（SANDBOX_UNAVAILABLE）、spawn 同步失败（EINVAL 等）与启动
 *   窗口内 error 事件（ENOENT/EACCES/E2BIG）reject；窗口外失败交 client
 *   握手期收口（close 事件结清桥 pending——语义同为 MCP_CONNECT_FAILED，
 *   不做二次包装）
 */
export function createMcpSpawner(
  dataDir: string,
  sandbox: SandboxService,
  workspace: string,
): (config: McpServerConfig) => Promise<SpawnedChild> {
  // 归一后的可写根（闭包级一次——两根装配期已定，逐 spawn 重算无意义）
  const writableRoots = [realizeRoot(dataDir), realizeRoot(workspace)];
  /** OS 层 probe 是否已过（探测全过后才置位——失败不消耗旗，后续 spawn 重探保形态统一） */
  let osLayerProbed = false;

  /**
   * OS 层 probe 醒（bridge-fleet ensureOsLayer 同形态）：MCP 服务器是长命
   * 进程，装载时点验真后端链（含单候选显式 probe——confine 内建对单候选
   * 不预探测）——坏了在 spawn 前统一以 SANDBOX_UNAVAILABLE 形态拒绝，而非
   * 每台服务器各自 spawn error 形态漂移。失败走 per-server catch → warn +
   * 摘服务器（MCP_CONNECT_FAILED 降级不阻启动）——「fail-closed」的本义是
   * 服务器绝不裸起，不是阻宿主 boot。
   */
  const ensureOsLayer = (): void => {
    if (osLayerProbed) return;
    const backends = sandbox.listBackends();
    // 空后端链 fail-closed：本平台零 OS 沙箱后端（win32 现状）——有服务器
    // 配置即起不来，与 exec confine 同律；无逃生门（v1 不开降格旋钮）
    if (backends.length === 0) {
      throw new AppError(
        SANDBOX_UNAVAILABLE,
        'MCP server OS 沙箱层不可用（本平台零 OS 沙箱后端）——fail-closed 拒 spawn，服务器绝不裸起（契约篇 §6.6 OS 沙箱层升格）',
      );
    }
    for (const backend of backends) {
      if (backend.probe !== undefined && !backend.probe(PROBE_TIMEOUT_MS)) {
        throw new AppError(
          SANDBOX_UNAVAILABLE,
          `MCP server OS 沙箱层探测失败（后端 ${backend.id}）——fail-closed 拒 spawn，服务器绝不裸起（契约篇 §6.6 OS 沙箱层升格）`,
        );
      }
    }
    // 旗后置：探测全过后才缓存「已验真」。若在探测前置位，首台 probe 失败
    // 即消耗旗，后续 spawn 跳过探测、confine 单候选链又不预 probe——失败形
    // 态漂移成 spawn ENOENT，违背本函数 JSDoc「统一 SANDBOX_UNAVAILABLE」
    // 不变量（遗漏大扫 2026-08-29 修复项）。失败态下每台服务器各重探一次，
    // 代价可忽略（probe 毫秒级，服务器数量个位数）。
    osLayerProbed = true;
  };

  return (config: McpServerConfig): Promise<SpawnedChild> =>
    new Promise((resolve, reject) => {
      // 首 spawn 前 probe-once；confine 空链双保险（probe 过但链被注销等
      // 竞态形态——两处都 fail-closed，语义同一）
      let confinedArgv: string[];
      try {
        ensureOsLayer();
        confinedArgv = sandbox.confine([config.command, ...(config.args ?? [])], {
          mode: 'workspace-write',
          workspaceRoot: realizeRoot(workspace),
          writableRoots,
        }).argv;
      } catch (err) {
        // SANDBOX_UNAVAILABLE（probe/confine 两源）或 spawn 参数前置失败——
        // 「未启动」腿，cause 直传（AppError 语义透传到 per-server catch）
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let child: ChildProcess;
      try {
        // spawn 消费 confine 产物：argv[0] = runner（sandbox-exec/bwrap），
        // 尾段 = 原命令——「exec 同款后端」的字面接线
        child = spawn(confinedArgv[0]!, confinedArgv.slice(1), {
          cwd: dataDir,
          env: buildChildEnv(process.env, { set: config.env } as ExecEnvTable),
          stdio: ['pipe', 'pipe', 'pipe'],
          // windowsHide 统一纪律（骨架篇 §7.6，P1-3——win32 CREATE_NO_WINDOW
          // 防子进程闪窗；MCP stdio 输出恒 UTF-8 属编码豁免面，不涉决策树）
          windowsHide: true,
          // POSIX 建进程组（detached）——killTree killpg 树杀的前提；Windows
          // 由 killTree 走 taskkill /T，spawn 侧无对应动作
          ...(process.platform !== 'win32' ? { detached: true } : {}),
        });
      } catch (err) {
        // spawn 同步抛出（参数非法/ENOMEM）——「未启动」腿，cause 直传
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // 启动窗口：error 事件先于 setImmediate 到达（ENOENT 等经 nextTick
      // 队列派发）即判「未启动」reject；窗口过后交握手期收口
      let opened = false;
      child.on('error', (err: Error) => {
        if (!opened) reject(err);
      });
      setImmediate(() => {
        opened = true;
        resolve(child as unknown as SpawnedChild);
      });
    });
}
