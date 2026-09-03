/**
 * L0 contracts — DEP 废弃登记簿（契约篇 §6.13.6 两级兼容架构的代内半边 +
 * §6.13.7 废弃遥测词汇，第八十七批批 3 落码）。
 *
 * 本文件两职：
 * - **DEP 注册簿**：stable 面删除/改形的唯一合法性凭证（§6.13.6「机器判级认
 *   登记不认动机」）。登记行形态 `{ dep, symbol, introducedIn, removalIn,
 *   replacement, codemod? }`，窗口 = 3 个 minor（拍板⑤）；行不变式（格式/
 *   唯一/窗口算术）由 check-api 查 3 执法 + deprecations.test.ts 同律锁——
 *   注册簿是纯数据，运行时不重复执法（CI 闸是唯一执法位）。
 * - **废弃遥测词汇登记**：`apps/deprecation-used` 以 **reserved 标记**入
 *   SessionEvent 目录（§6.13.7 落码形态）——宿主写点（废弃桥入口）随批 4
 *   收剑点火件才落，本批仅词汇登记与 obs 聚合建位（冷读 m3：check-events
 *   既有 reserved 豁免机制词在册而宿主派发点缺席不红；空表零行是批 3-批 4
 *   窗口的合法态）。
 *
 * 现役零废弃条目（首快照全 stable）——本文件是机制建位：首个真实废弃登记日
 * 起 check-api 查 3/4 实锁（机制常驻，生效日即执法日）。
 */

import { registerSessionEventType } from './session-events.js';

/** DEP 编号格式：`DEP-` + 三位数字（DEP-001 式——编号唯一，§6.13.6） */
export const DEP_ID_FORMAT = /^DEP-\d{3}$/;

/** 废弃登记项（§6.13.6 注册簿行形态——与 deprecated JSDoc 标签（@ 标签形）双向断言） */
export interface DeprecationEntry {
  /** DEP 编号（DEP-001 式——注册簿内唯一；标签 ↔ 注册簿双向对照的 join 键） */
  readonly dep: string;
  /** 被废弃符号的面清单坐标 `module::symbol`（与 check-api/快照 keyOf 同键形） */
  readonly symbol: string;
  /** 废弃登记时的 apiVersion（废弃窗起点——MAJOR.MINOR） */
  readonly introducedIn: string;
  /** 死期 apiVersion（≥ introducedIn + 3 minor；到期 check-api 红、删桥同笔走） */
  readonly removalIn: string;
  /** 替代指引（符号名或面描述——`berry apps check` 三色面的指引位） */
  readonly replacement: string;
  /** codemod 名（批 5 `berry apps migrate` 的 DEP→codemod 映射位；缺席 = 无自动迁移） */
  readonly codemod?: string;
}

/**
 * DEP 注册簿（模块级单源纯数据）。**新增条目 = 面变更事件**：同笔必须带
 * ①deprecated JSDoc 标签（@ 标签形——双向断言）②快照重跑（tier=deprecated 载荷从本表
 * join——extract-api-surface 终段）③check-api 查 3/4 即刻实锁。
 */
export const DEPRECATIONS: readonly DeprecationEntry[] = [];

/**
 * 废弃遥测词汇（§6.13.7）：`apps/deprecation-used`——log-only（不进表面推导，
 * 消费面 = obs rollup 聚合 → `berry apps check`）；tier stable（宿主遥测词，
 * 词汇本身不是废弃面）；**reserved**（宿主写点 = 批 4 废弃桥入口，本批在册
 * 而零派发点）。载荷 = `{ app, dep }`（触发应用 id + DEP 编号——rollup app 维
 * 载荷显式打标优先即读 `app` 字段）。
 */
registerSessionEventType({
  type: 'apps/deprecation-used',
  category: 'log-only',
  tier: 'stable',
  reserved: true,
});
