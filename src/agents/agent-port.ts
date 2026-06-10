/**
 * AgentPort 实现 — 封装 dialogue.send/reply IPC 的统一 Agent 间通信端口。
 *
 * 运行在 Agent 进程内，通过 IpcChildChannel 与 Kernel 通信。
 * 所有 Agent 间消息经 Kernel 中转（审计、Brain 异步监听、预算守卫）。
 *
 * 关键设计：
 * - request() 复用现有 DialogueRouter 的全部守卫（超时 60s、maxRounds=10、maxDialoguesPerRequest=3）
 * - 零新 IPC 协议 — 只是 dialogue.send/reply 的封装
 * - 安全门禁：to='brain' 和 self-messaging 在入口拒绝
 */

import type { IpcChildChannel } from '../kernel/ipc.js';
import type { IpcMessage } from '../kernel/types.js';
import type { DialogueMessagePayload } from '../contracts/dialogue.js';
import type {
  AgentPort,
  PortMessage,
  PortReply,
  PortReplyMetadata,
  AgentInfo,
  PortAskUserOptions,
} from '../contracts/agent-port.js';
import { FORBIDDEN_TARGETS, DEFAULT_REQUEST_TIMEOUT_MS } from '../contracts/agent-port-constants.js';
import type { ToolResult } from '../tools/types.js';
import type { AskUserOptions } from './module-agent.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { getToolByName } from '../tools/index.js';

const logger = getLogger('agent-port');

/** 13.0 §5.3.10: discover() 本地缓存 TTL（30s — 平衡实时性和 IPC 开销） */
const DIRECTORY_CACHE_TTL_MS = 30_000;

/** 缓存结构：entries + 拉取时间戳 */
let directoryCache: { entries: AgentInfo[]; fetchedAt: number } | null = null;

/** 测试辅助：清空缓存 */
export function clearAgentPortDirectoryCache(): void {
  directoryCache = null;
}

/** 测试辅助：读取当前缓存状态 */
export function getAgentPortDirectoryCache(): { entries: AgentInfo[]; fetchedAt: number } | null {
  return directoryCache;
}

/** createAgentPort 的依赖参数 */
export interface AgentPortDeps {
  /** 当前 Agent 的 IPC 通道 */
  ipc: IpcChildChannel;
  /** 当前 Agent 的名称（如 'code', 'memory'） */
  agentName: string;
  /** 来自 ModuleAgentContext.askUser 的闭包 */
  askUser: (question: string, opts?: AskUserOptions) => Promise<string>;
}

/**
 * 创建 AgentPort 实例。
 *
 * @param deps 依赖注入（ipc、agentName、askUser 闭包）
 * @returns AgentPort 实例
 */
export function createAgentPort(deps: AgentPortDeps): AgentPort {
  const { ipc, agentName, askUser } = deps;

  /** dialogueId → 等待 reply 的 resolve/reject（复用 dialogue-tools.ts 的 pending map 模式） */
  const pendingReplies = new Map<string, {
    resolve: (payload: DialogueMessagePayload) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // ─── 全局注册一次 dialogue.reply handler ───
  // 所有 request() 共享同一个 handler，按 dialogueId 分发
  ipc.onMessage('dialogue.reply', (msg: IpcMessage) => {
    const payload = msg.payload as DialogueMessagePayload;
    const pending = pendingReplies.get(payload.dialogueId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingReplies.delete(payload.dialogueId);
      pending.resolve(payload);
    }
  });

  /** 安全门禁：拒绝非法目标 */
  function validateTarget(target: string): void {
    if (FORBIDDEN_TARGETS.has(target)) {
      throw new Error(`target "${target}" is forbidden: direct brain messaging not allowed`);
    }
    if (target === agentName) {
      throw new Error(`self-messaging not allowed: ${agentName} → ${agentName}`);
    }
  }

  /** 等待 reply，带超时和清理 */
  function waitForReply(
    dialogueId: string,
    timeoutMs: number,
  ): Promise<DialogueMessagePayload> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingReplies.delete(dialogueId);
        reject(new Error(`AgentPort request timeout: no reply from dialogue ${dialogueId} within ${timeoutMs}ms`));
      }, timeoutMs);
      // unref() 让 Node.js 事件循环不因这个 timer 而阻塞退出
      // 测试环境（vitest fake timers）可能不支持 unref，安全调用
      if (typeof timer.unref === 'function') timer.unref();

      pendingReplies.set(dialogueId, { resolve, reject, timer });
    });
  }

  /** 将 DialogueMessagePayload 转换为 PortReply */
  function toPortReply(payload: DialogueMessagePayload): PortReply {
    return {
      from: payload.from,
      content: payload.content,
      metadata: payload.metadata as PortReplyMetadata | undefined,
    };
  }

  // ─── 6 原语实现 ───

  const port: AgentPort = {
    async request(msg: PortMessage, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PortReply> {
      // 安全门禁
      validateTarget(msg.to);

      const dialogueId = genId('dlg');
      const payload: DialogueMessagePayload = {
        dialogueId,
        sequenceNumber: -1, // Kernel 统一分配
        from: agentName,
        to: msg.to,
        content: msg.content,
        context: msg.context,
      };

      // 发送 dialogue.send IPC 到 Kernel，由 Kernel 路由到目标 Agent
      ipc.send('dialogue.send', 'core', payload, dialogueId);

      // 等待 reply（带超时）
      const replyPayload = await waitForReply(dialogueId, timeoutMs);
      logger.debug({
        dialogueId,
        from: agentName,
        to: msg.to,
        replyLen: replyPayload.content.length,
      }, 'AgentPort: request completed');

      return toPortReply(replyPayload);
    },

    send(msg: PortMessage): void {
      // 安全门禁（fire-and-forget 也需要）
      validateTarget(msg.to);

      const dialogueId = genId('dlg');
      const payload: DialogueMessagePayload = {
        dialogueId,
        sequenceNumber: -1,
        from: agentName,
        to: msg.to,
        content: msg.content,
        context: msg.context,
      };

      ipc.send('dialogue.send', 'core', payload, dialogueId);
      logger.debug({ dialogueId, from: agentName, to: msg.to }, 'AgentPort: send (fire-and-forget)');
    },

    async discover(): Promise<AgentInfo[]> {
      // 13.0 §5.3.10: 本地 30s 缓存 + 订阅 directory.changed 失效
      // 减少频繁 IPC 查询开销（discover() 通常被工具/逻辑高频调用）
      const now = Date.now();
      if (directoryCache && (now - directoryCache.fetchedAt) < DIRECTORY_CACHE_TTL_MS) {
        logger.debug({ ageMs: now - directoryCache.fetchedAt, count: directoryCache.entries.length }, 'AgentPort: discover cache hit');
        return directoryCache.entries;
      }

      // L5: 通过 IPC 查询 Kernel 的 Agent 注册表，返回实时在线状态
      const entries = await new Promise<AgentInfo[]>((resolve) => {
        const timer = setTimeout(() => {
          // 超时时回退到空列表（不阻塞调用方）
          resolve([]);
        }, 3000);
        if (typeof timer.unref === 'function') timer.unref();

        // 注册一次性 handler 接收 Kernel 回复
        ipc.onMessage('agent.discover.reply', (replyMsg: IpcMessage) => {
          clearTimeout(timer);
          resolve((replyMsg.payload as AgentInfo[]) ?? []);
        });

        // 发送查询请求到 Kernel
        ipc.send('agent.discover', 'core', {});
      });

      directoryCache = { entries, fetchedAt: now };
      logger.debug({ count: entries.length }, 'AgentPort: discover cache refreshed');
      return entries;
    },

    async askUser(question: string, opts?: PortAskUserOptions): Promise<string> {
      // 委托给 ModuleAgentContext.askUser（已有的 agent.ask_user / agent.user_reply 协议）
      return askUser(question, {
        options: opts?.options,
        context: opts?.context,
        timeoutMs: opts?.timeoutMs,
      });
    },

    async useTool(name: string, input: unknown): Promise<ToolResult> {
      // 复用当前进程的 ToolRegistry
      const tool = getToolByName(name);
      if (!tool) {
        return { content: `工具 "${name}" 不存在`, isError: true };
      }
      try {
        return await tool.execute(input);
      } catch (err) {
        return { content: `工具执行失败: ${(err as Error).message}`, isError: true };
      }
    },
  };

  return port;
}
