/**
 * L5 app — MCP 服务器子进程 spawn 组装（契约篇 §6.6 冷读 #1 裁决）。
 *
 * spawn/kill 组装上提组合根：mcp 件经闭包收 spawnServer/killTree，结构上
 * 不见 exec（内核篇席 14 边表 mcp = [contracts, context]——本文件是 exec
 * 与 mcp 之间唯一的组合根缝）。
 *
 * 组装纪律（契约篇 §6.6 transport/子进程治理条）：
 * - env = buildChildEnv 白名单（deny-by-default）+ config.env set 显式层
 *   （用户声明的键值直传——服务器凭证走这里，不经宿主翻译）；
 * - detached（POSIX）建进程组——killTree 树杀的前提（与 exec spawn 管道同纪律）；
 * - cwd 钉死 dataDir——防随会话漂移（服务器相对路径资源有稳定锚点）；
 * - stdio 三管全 pipe（行帧 JSON-RPC 走 stdin/stdout，stderr 进诊断日志）。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { buildChildEnv } from '../exec/index.js';
import type { ExecEnvTable } from '../contracts/exec.js';
import type { McpServerConfig } from '../mcp/index.js';
import type { SpawnedChild } from '../mcp/index.js';

/**
 * 构造 spawnServer 闭包（builtins 注入 mcp 件）。
 *
 * @param dataDir 数据目录（cwd 钉死锚点 = 登记簿同级根）
 * @returns (config) => Promise<SpawnedChild>——client 层 connectMcpServer 消费；
 *   spawn 同步失败（EINVAL 等）与启动窗口内 error 事件（ENOENT/EACCES/E2BIG）
 *   reject；窗口外失败交 client 握手期收口（close 事件结清桥 pending——语义
 *   同为 MCP_CONNECT_FAILED，不做二次包装）
 */
export function createMcpSpawner(dataDir: string): (config: McpServerConfig) => Promise<SpawnedChild> {
  return (config: McpServerConfig): Promise<SpawnedChild> =>
    new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(config.command, [...(config.args ?? [])], {
          cwd: dataDir,
          env: buildChildEnv(process.env, { set: config.env } as ExecEnvTable),
          stdio: ['pipe', 'pipe', 'pipe'],
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
