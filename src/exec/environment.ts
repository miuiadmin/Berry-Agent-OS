/**
 * L4 exec — environment 披露段（运行时骨架篇 §7.3 S 量级，exec 纵切同批落码）。
 *
 * 段 id `environment`（**无 `/` = 宿主自留地首例**——插件面注册无 `/` id 即
 * PROMPT_SECTION_INVALID，宿主半边经内部注册通道不走 ctx.prompts 插件面）。
 * 注册方 = 组合根 boot 装配期；**快照语义**：渲染时取值（render at boot /
 * /reload / /new——档位切换后新回合即见新档，旧回合提示词不追溯改写）。
 *
 * 内容五件（§7.3 定稿四件 + 2026-08-27 刀 1 第五件）：沙箱档位（effective
 * mode + 可写根）/ 平台 / 当前日期 / workspaceRoot / **装载态摘要**。exec 刀
 * 的配套披露——模型不知道自己在哪台机器、什么档位，就只能瞎猜（CC 同款第一
 * 块披露，pi 生态缺位的教训）；第五件同族——模型不知道装了什么，管理/审计
 * 类问题就只能瞎答。
 */

import { deriveWritableRoots } from '../safety/roots.js';
import type { SandboxMode } from '../safety/index.js';

/**
 * 插件装载计数（第五件的事实形态——组合根从 plugins 服务计数注入）。
 * 口径（契约篇 §3.4 第一刀细化段）：total = 组合树总行数（含 disabled/
 * unresolved——诊断装配态 total > 三态和属常态非矛盾）；三态只计已装载行。
 */
export interface PluginLoadCounts {
  /** 组合树总行数 */
  readonly total: number;
  /** activated 行数 */
  readonly activated: number;
  /** failed 行数 */
  readonly failed: number;
  /** skipped 行数 */
  readonly skipped: number;
}

/** 披露段事实取值器（快照语义——每次 render 现取，不缓存陈值） */
export interface EnvironmentFacts {
  /** 当前生效沙箱档位（三级解析产物） */
  readonly mode: () => SandboxMode;
  /** 会话工作区根（canonical 绝对路径） */
  readonly workspaceRoot: () => string;
  /**
   * 插件装载计数（第五件，2026-08-27 刀 1——可选：组合根注入、读 plugins
   * 服务；访问器须幂等无副作用——render 多次求值）。缺省不注入 = 略去该行
   * （诊断装配等无 plugins 语境的调用方向后兼容）
   */
  readonly pluginCounts?: () => PluginLoadCounts;
}

/** 星期几的中文短名（日期披露件——「今天周几」是模型高频盲区） */
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'] as const;

/**
 * 渲染 environment 披露段文本（每次调用现取事实——快照语义的实现体）。
 * 组合根把它包成 PromptSection 的 render 注入 prompts 服务。
 */
export function renderEnvironmentSection(facts: EnvironmentFacts): string {
  const mode = facts.mode();
  const workspaceRoot = facts.workspaceRoot();
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const weekday = WEEKDAY_NAMES[now.getDay()];
  const roots = deriveWritableRoots(workspaceRoot, mode).join('、');
  const lines = [
    '# 运行环境',
    '',
    `- 平台：${process.platform}（${process.arch}）`,
    `- 当前日期：${date}（周${weekday}）`,
    `- 工作区根：${workspaceRoot}（相对路径以此为锚）`,
    `- 沙箱档位：${mode}（可写根：${roots}）`,
  ];
  // 第五件装载态摘要（§7.3——O(1) 计数行不逐行，逐行面归 plugins_list 工具
  // 渐进披露；快照语义同段通用纪律：boot 收口重物化后计数已实）
  const counts = facts.pluginCounts?.();
  if (counts !== undefined) {
    lines.push(
      `- 插件 ${counts.total} 行：activated ${counts.activated} · failed ${counts.failed} · skipped ${counts.skipped}——细览用 plugins_list 工具`,
    );
  }
  return lines.join('\n');
}
