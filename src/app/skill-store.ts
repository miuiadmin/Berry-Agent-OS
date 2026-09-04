/**
 * L5 app — 独立技能件通道机器（第八十五批批 F，契约篇 §6.1 line 911「技能市场
 * 全面放开」条的机制面）。
 *
 * **为什么独立通道**：技能不是组合树行——挂载面是用户技能层
 * （`<home>/.berry/skills/<名>`，skills 发现序的 user 源），生效机制是 skills
 * 注册表 refresh 重扫，与「写组合行 = 生效」的应用通道正交。D1（第三方技能件
 * v1 结构性不可装）与 ②（第三方挂全局拒绝）两锁维持不变——本通道只服务商店
 * **内置精选**技能件（随包静态清单载荷），不开外源。
 *
 * 装机两态在技能通道的投影（与 apps.ts D2 两态同构，动作名对齐装机动词族）：
 * - **install**（装机）：SKILL.md 载荷拷入 staged 子树
 *   `<数据目录>/apps/skills/<名>/` + provenance 落账（sources.json 键域**第四形**
 *   `skills/<名>`——经 apps.ts 导出窄面单点收口）——**零生效**（不在任何发现
 *   位置，模型看不见）；
 * - **mount**（挂载）：staged 目录拷入用户技能层 + 调用方触发 skills refresh
 *   （重扫后渐进披露面即见）；
 * - **unmount**（卸挂载）：删用户层目录 + refresh；
 * - **uninstall**（卸载）：**三清**——staged 装机物 + 用户层挂载副本 + 账本条目
 *   （N-10 账实同批律同源）。
 *
 * 本文件纯 fs+账本机器（零 ctx 依赖、零组合根 import）：服务编排面在
 * store-app.ts（StoreService），refresh 编舞与呈现回执由彼处组装。
 */

import { cpSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, APP_INSTALL_FAILED, COMPOSITION_ROW_INVALID } from '../contracts/errors.js';
import { readSkillProvenance, removeSkillProvenance, upsertSkillProvenance } from './apps.js';

/**
 * 技能件名词法（与 SKILL.md name 校验同律：小写字母/数字/连字符——skill-md.ts
 * validateSkillName 的字符集面）。通道入口统一执法：防路径穿越（`../` 形）、防
 * 账本键污染（`/` 段分离符不得入名）。
 */
export const SKILL_STORE_NAME_PATTERN = /^[a-z0-9-]+$/;

/** 技能件通道路径束（宿主注入——staged 根取数据目录、挂载目标取用户技能层） */
export interface SkillStorePaths {
  /** 宿主数据目录（staged 装机子树 `<dataDir>/apps/skills/` 的根） */
  readonly dataDir: string;
  /** 用户技能层目录（挂载目标——homedir 基 `~/.berry/skills`，与 skills 发现序 user 源同位） */
  readonly userSkillsDir: string;
}

/** 技能件装机状态四态（清单「状态」列的机器形态——如实披露，不装没装不说装了） */
export type SkillInstallState = 'none' | 'staged' | 'mounted' | 'user-owned';

/** 技能件状态快照（inspect/详情/商店清单渲染共用） */
export interface SkillInstallSnapshot {
  /** 装机状态（四态——见 SkillInstallState 注） */
  readonly state: SkillInstallState;
  /** staged 装机物绝对路径（未装 = undefined） */
  readonly stagedDir: string | undefined;
  /** 用户层挂载目标绝对路径（未挂载 = undefined） */
  readonly mountedDir: string | undefined;
  /** 账本记录的装机时间（ISO 串；未装 = undefined） */
  readonly installedAt: string | undefined;
  /** 账本记录的版本（内置精选条目版本；未装 = undefined） */
  readonly version: string | undefined;
}

/** 技能名词法执法（fail-loud——非法名即拒，不静默修正） */
function assertValidSkillName(name: string): void {
  if (!SKILL_STORE_NAME_PATTERN.test(name) || name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `技能件名「${name}」非法（仅许小写字母/数字/连字符，首尾与连续连字符禁止——与 SKILL.md name 校验同律）`,
    );
  }
}

/** staged 装机物目录（<数据目录>/apps/skills/<名>——装机两态的仓库态半边） */
export function stagedSkillDir(dataDir: string, name: string): string {
  return join(dataDir, 'apps', 'skills', name);
}

/** 用户层挂载目标目录（<用户技能层>/<名>——生效半边） */
export function mountedSkillDir(userSkillsDir: string, name: string): string {
  return join(userSkillsDir, name);
}

/**
 * 读技能件装机状态（零副作用快照——四态判定序）：
 * 1. 账本在 + 用户层在 → `mounted`（商店装机且已挂载）；
 * 2. 账本在 + 用户层不在 → `staged`（装机零生效——D2 仓库态同义）；
 * 3. 账本不在 + 用户层在 → `user-owned`（用户自有同名技能——**商店不碰**：覆盖
 *    用户内容是破坏性动作，如实披露「已存在（非商店装机）」并拒绝装/挂）；
 * 4. 双不在 → `none`。
 * 账本在 + staged 目录不在 = 残迹态（上次卸载段间失败的重入面）——按账本记
 * `staged`（重装/卸载皆幂等收敛，与 apps.ts SF-8 残迹收尾律同源）。
 */
export function skillInstallSnapshot(paths: SkillStorePaths, name: string): SkillInstallSnapshot {
  const record = readSkillProvenance(paths.dataDir, name);
  const stagedDir = stagedSkillDir(paths.dataDir, name);
  const mountedDir = mountedSkillDir(paths.userSkillsDir, name);
  const mounted = existsSync(mountedDir);
  if (record !== undefined) {
    return {
      state: mounted ? 'mounted' : 'staged',
      stagedDir,
      mountedDir: mounted ? mountedDir : undefined,
      installedAt: record.installedAt,
      version: record.version,
    };
  }
  if (mounted)
    return { state: 'user-owned', stagedDir: undefined, mountedDir, installedAt: undefined, version: undefined };
  return { state: 'none', stagedDir: undefined, mountedDir: undefined, installedAt: undefined, version: undefined };
}

/**
 * 装机（staged 零生效）：载荷目录整树拷入 staged 子树 + provenance 落账。
 * @param name 技能名（词法执法）
 * @param payloadDir 载荷源目录（内置精选 = 包资产目录；须含 SKILL.md——缺即拒，
 *        商店精选面不许挂空目录装成「已装」）
 * @param version 精选条目版本（账本精确版本位——内置精选的审核批次锚）
 */
export function installSkillToStaged(
  paths: SkillStorePaths,
  name: string,
  payloadDir: string,
  version: string,
): { stagedDir: string } {
  assertValidSkillName(name);
  // 载荷防线：须是含 SKILL.md 的目录（内置精选载荷随包只读——存在性即完整面）
  if (!existsSync(join(payloadDir, 'SKILL.md'))) {
    throw new AppError(APP_INSTALL_FAILED, `技能件「${name}」载荷缺 SKILL.md（${payloadDir}）——精选载荷损坏，拒装`);
  }
  // 用户自有同名技能在位：拒绝覆盖（user-owned 态的执法半边——用户内容不可被
  // 商店动作静默冲掉；摘自有挂载是用户手上的动作，不在商店动词域）
  if (
    readSkillProvenance(paths.dataDir, name) === undefined &&
    existsSync(mountedSkillDir(paths.userSkillsDir, name))
  ) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `用户技能层已有同名技能「${name}」（非商店装机）——不覆盖用户自有内容；如需改装请先手动移除 ~/.berry/skills/${name}`,
    );
  }
  const target = stagedSkillDir(paths.dataDir, name);
  try {
    // staged 重装 = 覆写拷贝（同键覆写 = 重装的自然语义，与 upsert 账本同律）
    rmSync(target, { recursive: true, force: true });
    cpSync(payloadDir, target, { recursive: true });
  } catch (err) {
    throw new AppError(
      APP_INSTALL_FAILED,
      `技能件「${name}」staged 装机失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // 账本落账（键域第四形经窄面单点——ref 记内置精选源）
  upsertSkillProvenance(paths.dataDir, name, { ref: 'store-catalog', version });
  return { stagedDir: target };
}

/**
 * 挂载（生效）：staged 目录拷入用户技能层。refresh 编舞归调用方（服务面持有
 * skills 注册表——机器层不 import skills 模块，边界单向）。
 * 账本无记录即拒（未装先挂 = 跳过装机两态，fail-loud）；已挂载幂等重挂
 * （覆写拷贝——版本更新的自然路径）。
 */
export function mountSkillToUser(paths: SkillStorePaths, name: string): { mountedDir: string } {
  assertValidSkillName(name);
  if (readSkillProvenance(paths.dataDir, name) === undefined) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `技能件「${name}」未装机（账本无记录）——先安装（staged 零生效）再挂载，装机两态不可跳步`,
    );
  }
  const source = stagedSkillDir(paths.dataDir, name);
  if (!existsSync(join(source, 'SKILL.md'))) {
    throw new AppError(
      APP_INSTALL_FAILED,
      `技能件「${name}」staged 装机物缺 SKILL.md（${source}）——装机残迹，重装后再挂载`,
    );
  }
  const target = mountedSkillDir(paths.userSkillsDir, name);
  try {
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
  } catch (err) {
    throw new AppError(
      APP_INSTALL_FAILED,
      `技能件「${name}」挂载失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { mountedDir: target };
}

/**
 * 卸挂载：删用户层目录（回 staged 态——装机物与账本保留，重挂即恢复）。
 * 未挂载（目录不在）= no-op 速回（幂等；账本在而目录不在的残迹态也走此收敛）。
 */
export function unmountSkillFromUser(paths: SkillStorePaths, name: string): { removed: boolean } {
  assertValidSkillName(name);
  const target = mountedSkillDir(paths.userSkillsDir, name);
  if (!existsSync(target)) return { removed: false };
  try {
    rmSync(target, { recursive: true, force: true });
  } catch (err) {
    throw new AppError(
      APP_INSTALL_FAILED,
      `技能件「${name}」卸挂载失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { removed: true };
}

/**
 * 卸载三清（inspect 两段式的执行段机器）：staged 装机物 + 用户层挂载副本 +
 * 账本条目。各清独立收敛（段间失败重跑收敛——同 apps.ts SF-8 残迹收尾律）；
 * user-owned 态（账本无记录）即拒——商店动词不碰用户自有内容。
 * @returns 三清各段是否实际动作（回执披露用）
 */
export function uninstallSkillFully(
  paths: SkillStorePaths,
  name: string,
): { stagedRemoved: boolean; mountRemoved: boolean; ledgerRemoved: boolean } {
  assertValidSkillName(name);
  if (readSkillProvenance(paths.dataDir, name) === undefined) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `技能件「${name}」非商店装机（账本无记录）——用户自有技能请直接删目录（~/.berry/skills/${name}）`,
    );
  }
  const staged = stagedSkillDir(paths.dataDir, name);
  const stagedRemoved = existsSync(staged);
  if (stagedRemoved) rmSync(staged, { recursive: true, force: true });
  const mountRemoved = unmountSkillFromUser(paths, name).removed; // 目录在才动作（幂等）
  const ledgerRemoved = removeSkillProvenance(paths.dataDir, name);
  return { stagedRemoved, mountRemoved, ledgerRemoved };
}

/**
 * 载荷目录存在性探针（商店清单渲染用——精选载荷随包只读，缺目录 = 包损坏，
 * 清单面如实标注不可装；statSync 目录判定防文件冒充目录）。
 */
export function skillPayloadDirExists(payloadDir: string): boolean {
  try {
    return statSync(payloadDir).isDirectory();
  } catch {
    return false;
  }
}
