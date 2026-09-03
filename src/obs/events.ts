/**
 * obs 件自有总线词汇声明（契约篇 §1.1 逃生口的官方件宿主面——第四十六批抽出）。
 *
 * 单源纪律：本 const 供两消费方——①件 manifest `events` 字段（装载器装载
 * 阶段① 读 manifest 登记 + validateEventDefs 形状校验，src/context/loader.ts）；
 * ②check-events 应用声明层对照（tools/check-events.mjs jiti 导入本模块——
 * 契约篇 §6.3#4 族 1 词汇面 = 目录 ∪ 应用声明层）。
 *
 * 保持轻量：只 import 类型，零运行时依赖——重依赖进不了 checker
 * （compaction/checkpoint/goal 的 SessionEvent 宿主面 events.ts 同形先例；
 * 差异：它们是加载即副作用注册，本文件是惰性数据 const）。
 */
import type { LiveEventDefinition } from '../contracts/events.js';

/**
 * 告警触发词汇（刀二）：rollup 写入内联执法——新值过阈 + 冷却窗外即 emit；
 * 载荷 { ruleId, metric, agg, value, threshold, windowHours }。
 * 他应用可订阅联动（自有总线词非 durable——契约篇 §6.9 红线①）。
 */
export const OBS_EVENTS: readonly LiveEventDefinition[] = [
  {
    name: 'obs/alert',
    mode: 'emit',
    tier: 'stable',
    note: '观测告警触发面（rollup 写入内联执法：过阈 + 冷却窗外触发；载荷 { ruleId, metric, agg, value, threshold, windowHours }）',
  },
];
