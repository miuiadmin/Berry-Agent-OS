/**
 * L3 checkpoint — durable 会话事件词汇宿主面注册（会话篇 §5.3 账的分居条，
 * 2026-08-30 纵切落码；冷读 CR-1 blocker 改向的落点）。
 *
 * 三词出生纪律（git/range 见下方数组注）：
 * - checkpoint/snapshot：捕获审计（log-only——不进表面推导；data 只载
 *   {id, triggerTool, files 件数, bytes}，不含路径清单——64KiB 护栏纪律；
 *   guard 捕获照记、data 标 guard: true——「回退本身可回退」的审计账，CR-11）
 * - checkpoint/rewind：回退叙事（surface——旧会话时间线留一行；**投影折叠
 *   形态声明（§1.1 第十二批成规，CR-4）：不进 deriveMessages 折叠、UI 转录行
 *   only**——derive 的 default 分支天然不产出消息，模型不可见：回退是操作者
 *   叙事非模型上下文；转录行渲染挂 Web 通道批）
 *
 * 走宿主面模块级注册而非 ctx.registerSessionEventType（compaction/events.ts
 * 同款，check-events 注释钉死的官方件纪律）：durable 词汇的可读性不随组合树
 * 行装载漂移——checkpoint 是 Ring 2 真·可卸行，件被禁用后曾回退过的会话日志
 * 必须永远可读（未注册且非 ignorable 类型读侧整体拒绝 = 件卸载即旧会话变砖，
 * 与「真·可卸」自相矛盾）。
 *
 * 本文件运行时依赖保持轻量（只 import contracts 注册面，不连锁 SQLite/文件域）
 * ——check-events.mjs 族 3 直接 jiti 导入本模块取注册表运行时面。
 */

import { registerSessionEventType } from '../contracts/session-events.js';
import type { SessionEventTypeDefinition } from '../contracts/session-events.js';

/**
 * checkpoint 三词定义。git/range（第六十一批，§5.3 git 锚条款）= 交付链 Output
 * 锚：{before, after, commits, files(≤50), dirtyBefore, dirtyAfter}——run 级
 * 「这次交付产出了哪些 commit」的 durable 事实（头未动且 dirty 未变不落账）。
 * log-only（不进投影）：消费面是 SKILL 沉淀证据链与审计，非模型上下文。
 */
export const CHECKPOINT_EVENT_TYPES: readonly SessionEventTypeDefinition[] = [
  { type: 'checkpoint/snapshot', category: 'log-only' },
  { type: 'checkpoint/rewind', category: 'surface' },
  { type: 'git/range', category: 'log-only' },
];

// 模块加载即注册（官方件随包代码存在、组合无关）
for (const def of CHECKPOINT_EVENT_TYPES) {
  registerSessionEventType(def);
}
