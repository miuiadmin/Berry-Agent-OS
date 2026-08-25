/**
 * L5 app — convertToLlm 默认实现（骨架篇 §2.3 关口：AgentMessage[] → Message[]）。
 *
 * 内核不含策略：loop 只在 LLM 调用边界调一次本函数。默认策略三行——
 * ① 标准三角色零转换透传（与 pi-ai 消息同构，骨架篇 §5.4 超集兼容子集）；
 * ② 自定义角色走注册时的 toLlm 定义（registerMessageRole 的转换钩）；
 * ③ 未注册转换或 toLlm 返回 null 的角色过滤丢弃（「模型不可见」也是策略）。
 * 永不 throw——转换失败即静默剔除该条（违约响亮化归装配期角色注册面）。
 *
 * #16 收口（2026-08-25）：**未注册角色**的丢弃不再是全静默——onDrop 回调
 * 携角色名上报（装配层接 debug 日志）。注意分界：注册角色的 toLlm:null 是
 * 设计内过滤（bash 执行记录类每请求都丢，不叫回调免刷日志）；onDrop 只咬
 * 「本该注册却没注册」的可疑丢弃——插件作者注入自造角色名被无声蒸发的陷阱
 * 从此有痕迹。
 */

import type { Message } from '../contracts/llm.js';
import type { AgentMessage } from '../contracts/messages.js';
import { getMessageRoleDefinition, isStandardMessage } from '../contracts/messages.js';

/**
 * 默认 LLM 边界转换（app 装配层注入 loop 的 convertToLlm）。
 * @param messages 会话转录（AgentMessage 级全量）
 * @param onDrop 未注册角色丢弃的诊断回调（角色名入参——装配层接 debug 日志；
 *   注册角色的显式 null 丢弃不触发）
 * @returns 模型可见消息序列（标准角色引用直通，无拷贝）
 */
export function defaultConvertToLlm(messages: readonly AgentMessage[], onDrop?: (role: string) => void): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    // 正向守卫窄化：真分支 = 标准三角色（直通），假分支 = CustomMessage（走定义）
    if (isStandardMessage(message)) {
      out.push(message);
      continue;
    }
    const definition = getMessageRoleDefinition(message.role);
    if (definition === undefined) {
      // 未注册角色 = 可疑丢弃（#16 陷阱面）：上报角色名，不再全静默
      onDrop?.(message.role);
      continue;
    }
    const converted = definition.toLlm?.(message) ?? null;
    if (converted === null) continue; // 显式丢弃 → 模型不可见
    out.push(...(Array.isArray(converted) ? converted : [converted]));
  }
  return out;
}
