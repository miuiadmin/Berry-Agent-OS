/**
 * L5 app — ctx.agent 具名服务（骨架篇 §9.3 动作层落码注记，2026-08-24 goal 纵切一）。
 *
 * 插件注入正门：sendUserMessage（三通道自适应——忙→steer / 闲→followUp /
 * 拆卸中→inject，路由归 ConversationDriver.deliver）+ onRunSettled（run 结算
 * 信号订阅位——goal 续跑触发 / 未来 scheduler 与通知类插件共用）。
 *
 * 构造序约束的结构解（同 ④d onSubagentSettle 晚绑定先例）：服务在 ④ 系提供
 * （插件装载 ⑨ 之前 inject 即得），驱动在 ⑧ 构造——attach 在 ⑧ 后收口接线。
 * 回调违约隔离与事件监听器同纪律：订阅者抛错 logger 吞掉，不炸结算链与后续
 * 订阅者；不承诺恰好一次（订阅方须容忍重复通知，deliver 路由自适应目标状态）。
 */

import { AppError, AGENT_DELIVER_AS_UNSUPPORTED, AGENT_SERVICE_DETACHED, describeError } from '../contracts/errors.js';
import type { UserMessage, MessageSource } from '../contracts/llm.js';
import type { RunStatus } from '../agent/events.js';
import type { Disposer } from '../context/types.js';
import type { ContextScope } from '../context/types.js';
import type { ConversationDriver } from './assembly.js';

/** sendUserMessage 可选项（骨架篇 §9.3 签名） */
export interface SendUserMessageOptions {
  /** 注入归因（会话篇 §3.1 dsh-8 词汇——如 'plugin:goal'）；缺省不落字段（读侧视为 'user'） */
  readonly source?: MessageSource;
  /** true = 自激唤醒（计入自激预算 maxConsecutiveWakes——闲时 followUp 前 check、超帽降级 inject）；缺省 false（用户手写语义恢复预算） */
  readonly backgroundWake?: boolean;
  /** 定向投递（'steer'/'inject'）——M2+ 预留位，显式携带即 AGENT_DELIVER_AS_UNSUPPORTED */
  readonly deliverAs?: 'steer' | 'inject';
}

/** run 结算载荷（onRunSettled 订阅面——status 三值对齐 RunStatus） */
export interface RunSettled {
  /** 本 run 终态（completed / aborted / failed——含异常兜底合成路） */
  readonly status: RunStatus;
}

/** ctx.agent 服务面（provide('agent') 的形状——插件经 inject 'agent' 结构性取得） */
export interface AgentServiceFace {
  /** 三通道注入（构造 UserMessage 经 driver.deliver 透传；返回 void——steer 入队语义下 run 边界模糊，§9.3 ask 是等待结果的另一面 ⏳） */
  sendUserMessage(content: string | UserMessage['content'], opts?: SendUserMessageOptions): void;
  /** 订阅 run 结算（每个 run 终结派发一次；Disposer 注销——挂 ctx.effect 即随插件回卷） */
  onRunSettled(cb: (settled: RunSettled) => void): Disposer;
}

/** createAgentService 产物：face = provide 用服务面；attach = 组合根 ⑧ 接驱动 */
export interface AgentService {
  readonly face: AgentServiceFace;
  /** 接驱动（⑧ ConversationDriver 构造后收口——此后注入与订阅全部生效） */
  attach(driver: ConversationDriver): void;
}

/**
 * 创建 agent 服务（组合根 ④ 系调用；attach 前调用面一律 AGENT_SERVICE_DETACHED
 * 响亮拒绝——结构上插件装载晚于 attach，防御位不静默丢消息）。
 */
export function createAgentService(scope: ContextScope): AgentService {
  /** 驱动活引用（attach 后恒有值） */
  let driver: ConversationDriver | undefined;
  /** onRunSettled 订阅表（派发快照遍历——派发中注销/新订不炸迭代） */
  const subscribers = new Set<(settled: RunSettled) => void>();

  /** 单订阅者派发壳（违约隔离：抛错 logger 吞掉，不断结算链） */
  const dispatch = (settled: RunSettled): void => {
    for (const cb of [...subscribers]) {
      try {
        cb(settled);
      } catch (err) {
        scope.logger.error('agent.onRunSettled 订阅者违约（已隔离）', { error: describeError(err) });
      }
    }
  };

  const face: AgentServiceFace = {
    sendUserMessage(content, opts = {}) {
      // 预留位执法：定向投递不做半实现（缺省自适应即现行业务全部所需）
      if (opts.deliverAs !== undefined) {
        throw new AppError(
          AGENT_DELIVER_AS_UNSUPPORTED,
          `sendUserMessage 不支持显式 deliverAs=${opts.deliverAs}（三通道自适应缺省即现行业务所需；定向投递为 M2+ 预留位）`,
        );
      }
      if (driver === undefined) {
        throw new AppError(
          AGENT_SERVICE_DETACHED,
          'ctx.agent 尚未接线驱动（组合根 ⑧ attach 前不可注入——装配序上插件装载晚于 attach，此处不可达即装配序被破坏）',
        );
      }
      const message: UserMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
        ...(opts.source !== undefined ? { source: opts.source } : {}),
      };
      driver.deliver(message, { backgroundWake: opts.backgroundWake === true });
    },

    onRunSettled(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };

  return {
    face,
    attach(target) {
      driver = target;
      // 驱动侧只挂一个总派发器（隔离责任在本服务——驱动保持朴素订阅表）
      target.onRunSettled(dispatch);
    },
  };
}
