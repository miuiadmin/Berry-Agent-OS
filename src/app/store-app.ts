/**
 * L5 app — 应用商店官方件（`builtin:store`，默认层第十九行，第八十五批批 F，
 * 契约篇 §6.12）。Ring 2 真·可卸：overlay 禁用即桌面商店入口诚实缺席回落，
 * 核心循环不破。
 *
 * 三市场（tab 切换 ←→，照桌面分组切换语义）：**技能 / MCP / 应用**。
 * - 技能市场动作走**独立技能件通道**（§6.1 line 911——机器在 skill-store.ts：
 *   安装 = staged 零生效 + provenance 键域第四形 `skills/<名>`；挂载 = 进用户
 *   技能层 + skills refresh；卸载三清）；
 * - 应用市场安装 = `ctx.apps` 既有 install/mount 装机管道（D2 两态：装机 ≠
 *   生效——回执明示两态与挂载指引，禁第二实现）；
 * - MCP 市场 = mcp 行 config `servers` 键合并写入（configure 顶层键整值替换
 *   语义——先读 overlay 现值合并再整体落，免深合并幻觉）。
 *
 * 内置精选 = 随包静态清单（`apps/store-catalog.json` + `apps/store-catalog/`
 * 载荷子树）——审核位如实：**内置精选恒「已审」**（随包资产，供应链面 = 包
 * 本身）；外源接入（registry URL/git）不做（§6.12 反目标）。
 *
 * 安全面：安装/卸载动作经二次确认原语（回执带 confirm 段——与桌面管理面/
 * 卸载族同一 confirm 机器，壳零新确认逻辑）+ provenance 披露（装了什么从哪
 * 来，inspect 段即披露面）。
 *
 * 服务面 `store`（ctx provide）**不进 SERVICE_CATALOG**（assistant/desktop/
 * memory-review 先例——行内窄面非跨件公共 API）；CLI 对等族（berry apps
 * skill-*）与桌面商店视图消费同一服务面单源。
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext, BuiltinAppModule } from '../contracts/app.js';
import type { DesktopAdminResult } from './desktop-shell.js';
import { MCP_SERVER_NAME_PATTERN } from '../mcp/index.js';
import { loadOverlayRows } from './composition.js';
import {
  installSkillToStaged,
  mountSkillToUser,
  skillInstallSnapshot,
  skillPayloadDirExists,
  stagedSkillDir,
  uninstallSkillFully,
  unmountSkillFromUser,
  type SkillInstallState,
  type SkillStorePaths,
} from './skill-store.js';

/* ---------------- 内置精选清单（随包静态资产——单次读缓存） ---------------- */

/** 商店应用装机 id（宿主投影消费的单源常量——桌面清单行 desktopView 分流判据） */
export const STORE_APP_ID = 'store';

/** 精选清单路径锚（包根 apps/——src/dist 同构上推；admin 件 packageRoot 先例） */
const CATALOG_URL = new URL('../../apps/store-catalog.json', import.meta.url);
/** 精选载荷子树锚（技能件 SKILL.md 目录——install 的拷贝源） */
const CATALOG_SKILLS_URL = new URL('../../apps/store-catalog/skills', import.meta.url);

/** 精选技能条目（store-catalog.json skills[] 项） */
interface CatalogSkillEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
}

/** 精选 MCP 服务器条目（store-catalog.json mcp[] 项——commandHint 是参考非装机值） */
interface CatalogMcpEntry {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly commandHint: string;
}

/** 精选应用条目（store-catalog.json apps[] 项——ref 相对包根，install 时解析） */
interface CatalogAppEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly ref: string;
}

/** 精选清单原始形状（store-catalog.json 顶层） */
interface CatalogFile {
  readonly version: string;
  readonly skills: readonly CatalogSkillEntry[];
  readonly mcp: readonly CatalogMcpEntry[];
  readonly apps: readonly CatalogAppEntry[];
}

/** 精选载荷目录（apps/store-catalog/skills/<名>——install 拷贝源；测试与视图消费） */
export function catalogSkillPayloadDir(name: string): string {
  return join(fileURLToPath(CATALOG_SKILLS_URL), name);
}

/** 清单缓存（随包只读资产——进程一次读；损坏响亮抛，首用即面市由调用侧呈现） */
let catalogCache: CatalogFile | undefined;

/** 读内置精选清单（含轻形状校验——包资产损坏 fail-loud 不装聋） */
function loadCatalog(): CatalogFile {
  if (catalogCache !== undefined) return catalogCache;
  const raw = JSON.parse(readFileSync(fileURLToPath(CATALOG_URL), 'utf8')) as CatalogFile;
  if (
    typeof raw?.version !== 'string' ||
    !Array.isArray(raw.skills) ||
    !Array.isArray(raw.mcp) ||
    !Array.isArray(raw.apps)
  ) {
    throw new Error(`内置精选清单损坏：${fileURLToPath(CATALOG_URL)}（须含 version/skills/mcp/apps 四键）`);
  }
  catalogCache = raw;
  return raw;
}

/* ---------------- 商店清单投影（呈现面——状态活取不缓存） ---------------- */

/** 技能市场条目（呈现 + 状态四态） */
export interface StoreSkillListing {
  readonly kind: 'skill';
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  /** 审核位——内置精选恒已审（随包资产；如实披露不做假审） */
  readonly reviewed: true;
  /** 载荷在包（false = 包损坏——清单面如实标注不可装） */
  readonly payloadReady: boolean;
  /** 装机状态（none/staged/mounted/user-owned——机器面 skillInstallSnapshot 同源） */
  readonly state: SkillInstallState;
}

/** MCP 市场条目 */
export interface StoreMcpListing {
  readonly kind: 'mcp';
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** 参考启动命令（人读提示——v1 须用户供绝对路径装机） */
  readonly commandHint: string;
  readonly reviewed: true;
  /** mcp 行 config servers 键已配置（在场 = 已添加） */
  readonly configured: boolean;
}

/** 应用市场条目 */
export interface StoreAppListing {
  readonly kind: 'app';
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** 装机引用（相对包根的 local 直引——服务面 install 时解析绝对路径） */
  readonly ref: string;
  readonly reviewed: true;
  /** 装机状态：none 未装 / installed 已装未挂（D2 仓库态）/ mounted 有组合行 */
  readonly state: 'none' | 'installed' | 'mounted';
}

/** 三市场清单（catalog() 产物——每次活取状态零缓存） */
export interface StoreCatalog {
  readonly skills: readonly StoreSkillListing[];
  readonly mcp: readonly StoreMcpListing[];
  readonly apps: readonly StoreAppListing[];
}

/** 呈现 tab 序（←→ 切换序——技能 → MCP → 应用 循环；桌面商店视图消费） */
export const STORE_TABS: readonly (keyof StoreCatalog)[] = ['skills', 'mcp', 'apps'];

/* ---------------- 宿主服务窄面（结构性子集——零跨件真类型 import） ---------------- */

/**
 * 装机管道窄面（真身 = ctx 键 'apps'——AppsService 的商店消费子集，禁第二
 * 实现）。AppsService 实例结构性覆盖本面（方法签名更宽 + 返回形超集）。
 */
interface StoreAppsFace {
  install(ref: string): Promise<{ readonly id: string; readonly message: string }>;
  mount(
    installId: string,
    opts?: { apps?: readonly string[] },
  ): Promise<{ readonly id: string; readonly apps: readonly string[]; readonly message: string }>;
  list(): readonly { readonly id: string; readonly status: string }[];
  configure(id: string, patch: Readonly<Record<string, unknown>>): Promise<{ readonly message: string }>;
}

/** 技能注册表窄面（真身 = ctx 键 'skills'——挂载/卸挂载后的重扫生效面） */
interface StoreSkillsFace {
  refresh(): unknown;
}

/** 数据目录服务窄面（真身 = ctx 键 'paths'——dataDir() 取数据根） */
interface StorePathsFace {
  dataDir(): string;
}

/**
 * 商店服务面（ctx 键 `store`——桌面商店视图与 CLI 对等族的同一单源）。
 * 动词回执统一 `DesktopAdminResult`（string = 单行拒因；receipt = 回执视图，
 * confirm 在场 = 两段式第二段——与桌面管理面共用 confirm 机器）。
 */
export interface StoreService {
  /** 三市场清单（状态活取；清单损坏抛错——调用侧呈现） */
  catalog(): StoreCatalog;
  /** 技能安装确认披露（两段式第一段：精选条目 + provenance 面 + 两态说明） */
  skillInstallInspect(name: string): DesktopAdminResult;
  /** 技能安装（staged 零生效 + 落账） */
  installSkill(name: string): Promise<DesktopAdminResult>;
  /** 技能挂载（进用户技能层 + refresh 生效） */
  mountSkill(name: string): Promise<DesktopAdminResult>;
  /** 技能卸挂载（删用户层 + refresh；回 staged 态） */
  unmountSkill(name: string): Promise<DesktopAdminResult>;
  /** 技能卸载检视（两段式第一段：三清将删什么） */
  skillUninstallInspect(name: string): DesktopAdminResult;
  /** 技能卸载执行（三清：staged + 用户层副本 + 账本条目） */
  uninstallSkill(name: string): Promise<DesktopAdminResult>;
  /** MCP 服务器添加（servers 键合并写入——command 须绝对路径 v1） */
  addMcpServer(name: string, command: string, args?: readonly string[]): Promise<DesktopAdminResult>;
  /** MCP 服务器移除（servers 键删后整体落） */
  removeMcpServer(name: string): Promise<DesktopAdminResult>;
  /** 应用安装确认披露（两段式第一段） */
  appInstallInspect(id: string): DesktopAdminResult;
  /** 应用安装（ctx.apps 既有管道——D2 仓库态回执） */
  installApp(id: string): Promise<DesktopAdminResult>;
  /** 应用挂载（写组合行挂应用域——ctx.apps 既有 mount 管道） */
  mountApp(id: string, apps: readonly string[]): Promise<DesktopAdminResult>;
}

/** 商店件构造参数（assembly 注入——用户技能层 homedir 基与 skills 发现序同源） */
export interface StoreAppDeps {
  /** 用户技能层目录（挂载目标 = <userSkillsDir>/<名>——defaultSkillLocations user 源同位） */
  readonly userSkillsDir: string;
}

/** 错误 → 单行拒因（服务面吞异常回 string——商店动作不炸壳/CLI 退出码单源） */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 技能装机状态人读词（清单与回执共用单源） */
const SKILL_STATE_LABELS: Record<SkillInstallState, string> = {
  none: '未装',
  staged: '已装机（零生效）',
  mounted: '已挂载',
  'user-owned': '用户层已有同名（非商店装机）',
};

/**
 * 构造商店服务面（桌面商店视图与 CLI 对等族的公共真身）。
 * 四键全闭包注入：dataDir/userSkillsDir 定基技能件通道路径；apps/skills 是
 * boot 期就位的宿主服务（行 apply 期取得）。confirm.run 闭包引用 service
 * 自身（两段式第二段 = 同面 execute 动词）——闭包仅在构造完成后被调，TDZ 安全。
 */
export function createStoreService(deps: {
  readonly dataDir: string;
  readonly userSkillsDir: string;
  readonly apps: StoreAppsFace;
  readonly skills: StoreSkillsFace;
}): StoreService {
  /** 技能件通道路径束（机器层单一定基点） */
  const skillPaths: SkillStorePaths = { dataDir: deps.dataDir, userSkillsDir: deps.userSkillsDir };

  /** mcp 行当前 servers 键值（overlay 新鲜读——configure 整值替换语义的合并基线） */
  const currentMcpServers = (): Record<string, unknown> => {
    const row = loadOverlayRows(deps.dataDir).find((r) => r.id === 'mcp');
    const config = row?.config as { servers?: Record<string, unknown> } | undefined;
    return config?.servers !== undefined && typeof config.servers === 'object' ? { ...config.servers } : {};
  };

  /** 应用市场条目装机状态派生（apps.list 行命中 + installed-unmounted 差集态） */
  const appStateOf = (
    rows: readonly { readonly id: string; readonly status: string }[],
    id: string,
  ): StoreAppListing['state'] => {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) return 'none';
    return row.status === 'installed-unmounted' ? 'installed' : 'mounted';
  };

  // 先声明后构造：confirm.run 闭包引用 service（构造完成后才被调——TDZ 安全）
  const service: StoreService = {
    catalog(): StoreCatalog {
      const catalog = loadCatalog();
      const rows = deps.apps.list();
      return {
        skills: catalog.skills.map((entry) => ({
          kind: 'skill' as const,
          ...entry,
          reviewed: true as const,
          payloadReady: skillPayloadDirExists(catalogSkillPayloadDir(entry.name)),
          state: skillInstallSnapshot(skillPaths, entry.name).state,
        })),
        mcp: catalog.mcp.map((entry) => ({
          kind: 'mcp' as const,
          ...entry,
          reviewed: true as const,
          configured: Object.prototype.hasOwnProperty.call(currentMcpServers(), entry.name),
        })),
        apps: catalog.apps.map((entry) => ({
          kind: 'app' as const,
          ...entry,
          reviewed: true as const,
          state: appStateOf(rows, entry.id),
        })),
      };
    },

    skillInstallInspect(name: string): DesktopAdminResult {
      const entry = loadCatalog().skills.find((s) => s.name === name);
      if (entry === undefined) return `精选清单无技能「${name}」（外源接入不做——§6.12 反目标）`;
      if (!skillPayloadDirExists(catalogSkillPayloadDir(name))) {
        return `技能「${name}」载荷不在包（apps/store-catalog/skills/${name}）——包损坏，拒装`;
      }
      const snapshot = skillInstallSnapshot(skillPaths, name);
      if (snapshot.state === 'user-owned') {
        return `用户技能层已有同名技能「${name}」（非商店装机）——不覆盖用户自有内容`;
      }
      return {
        title: `安装确认：${entry.title}（${entry.name}）`,
        lines: [
          `  描述：${entry.description}`,
          '  来源：内置精选（随包静态清单——审核位：已审）',
          `  版本：${entry.version}`,
          `  当前状态：${SKILL_STATE_LABELS[snapshot.state]}`,
          `  装机目标（staged，零生效）：${stagedSkillDir(deps.dataDir, name)}`,
          `  provenance 落账：sources.json 键 skills/${name}（source=skill 第四形）`,
          '',
          '装机两态：安装 = 进 staged 仓库态（模型看不见）；挂载 = 进用户技能层生效。',
        ],
        confirm: {
          label: '确认安装（staged 零生效）',
          run: () => service.installSkill(name),
        },
      };
    },

    async installSkill(name: string): Promise<DesktopAdminResult> {
      try {
        const entry = loadCatalog().skills.find((s) => s.name === name);
        if (entry === undefined) return `精选清单无技能「${name}」`;
        const { stagedDir } = installSkillToStaged(skillPaths, name, catalogSkillPayloadDir(name), entry.version);
        return {
          title: `已安装技能 ${name}（仓库态·零生效）`,
          lines: [
            `  staged 装机物：${stagedDir}`,
            `  provenance：sources.json 键 skills/${name}（内置精选 ${entry.version}，已审）`,
            '',
            '装机两态：当前零生效——挂载后才进模型技能面：',
            '  · 商店视图对该条目继续动作（挂载）',
            `  · CLI：berry apps skill-mount ${name}`,
          ],
        };
      } catch (err) {
        return `技能安装失败：${errText(err)}`;
      }
    },

    async mountSkill(name: string): Promise<DesktopAdminResult> {
      try {
        const snapshot = skillInstallSnapshot(skillPaths, name);
        if (snapshot.state === 'user-owned') {
          return `用户技能层已有同名技能「${name}」（非商店装机）——不覆盖用户自有内容`;
        }
        const { mountedDir } = mountSkillToUser(skillPaths, name);
        deps.skills.refresh(); // 生效面：注册表重扫用户技能层（渐进披露即见）
        return {
          title: `已挂载技能 ${name}`,
          lines: [`  用户技能层：${mountedDir}`, '  skills 注册表已 refresh——渐进披露面即见（/skills 核对）'],
        };
      } catch (err) {
        return `技能挂载失败：${errText(err)}`;
      }
    },

    async unmountSkill(name: string): Promise<DesktopAdminResult> {
      try {
        const snapshot = skillInstallSnapshot(skillPaths, name);
        if (snapshot.state === 'user-owned') {
          return `「${name}」非商店装机（用户自有技能）——商店不碰用户内容，如需移除请手动删目录`;
        }
        const { removed } = unmountSkillFromUser(skillPaths, name);
        deps.skills.refresh(); // 生效面同源：摘除后重扫
        return removed
          ? {
              title: `已卸挂载技能 ${name}（回仓库态）`,
              lines: ['  用户技能层副本已删；staged 装机物与账本保留——重挂即恢复'],
            }
          : `「${name}」本就未挂载（no-op）`;
      } catch (err) {
        return `技能卸挂载失败：${errText(err)}`;
      }
    },

    skillUninstallInspect(name: string): DesktopAdminResult {
      const snapshot = skillInstallSnapshot(skillPaths, name);
      if (snapshot.state === 'none') return `技能「${name}」未装（账本无记录）`;
      if (snapshot.state === 'user-owned') {
        return `「${name}」非商店装机（用户自有技能）——请直接删目录 ${snapshot.mountedDir}`;
      }
      return {
        title: `卸载检视：技能 ${name}（三清）`,
        lines: [
          `  ① staged 装机物：${snapshot.stagedDir}`,
          `  ② 用户层挂载副本：${snapshot.state === 'mounted' ? `${snapshot.mountedDir}（在）` : '（不在——仅 staged 态）'}`,
          `  ③ 账本条目：sources.json 键 skills/${name}`,
          `  装机来源：${snapshot.version !== undefined ? `内置精选 ${snapshot.version}（已审）` : '内置精选（已审）'}`,
          ...(snapshot.installedAt !== undefined ? [`  装机时间：${snapshot.installedAt}`] : []),
        ],
        confirm: {
          label: '确认卸载（三清）',
          run: () => service.uninstallSkill(name),
        },
      };
    },

    async uninstallSkill(name: string): Promise<DesktopAdminResult> {
      try {
        const result = uninstallSkillFully(skillPaths, name);
        deps.skills.refresh(); // 挂载副本若在，摘除后重扫
        return {
          title: `已卸载技能 ${name}`,
          lines: [
            `  staged 装机物：${result.stagedRemoved ? '已删' : '（不在——残迹收敛）'}`,
            `  用户层副本：${result.mountRemoved ? '已删' : '（不在）'}`,
            `  账本条目：${result.ledgerRemoved ? '已清' : '（不在——残迹收敛）'}`,
          ],
        };
      } catch (err) {
        return `技能卸载失败：${errText(err)}`;
      }
    },

    async addMcpServer(name: string, command: string, args?: readonly string[]): Promise<DesktopAdminResult> {
      if (!MCP_SERVER_NAME_PATTERN.test(name)) {
        return `MCP 服务器名「${name}」非法（仅许字母/数字/连字符——空白与特殊字符禁入，防击穿工具名解析）`;
      }
      if (!isAbsolute(command)) {
        return `command 须为可执行文件绝对路径（v1 不认相对路径/npx 形——「${command}」）；参考启动命令见清单 commandHint，解析后填绝对路径`;
      }
      try {
        const servers = currentMcpServers();
        servers[name] = { command, ...(args !== undefined && args.length > 0 ? { args: [...args] } : {}) };
        const report = await deps.apps.configure('mcp', { servers }); // 顶层键整值替换——合并后整体落
        const total = Object.keys(currentMcpServers()).length;
        return {
          title: `已添加 MCP 服务器 ${name}`,
          lines: [
            `  ${report.message}`,
            `  command：${command}${args !== undefined && args.length > 0 ? ` ${args.join(' ')}` : ''}`,
            `  servers 键现存 ${total} 个（既有键保留——合并写入）`,
            '',
            '生效提示：mcp 行 config 不自动链重载——/reload 后子进程按需 spawn（servers 空时行惰性无害）。',
          ],
        };
      } catch (err) {
        return `MCP 服务器添加失败：${errText(err)}`;
      }
    },

    async removeMcpServer(name: string): Promise<DesktopAdminResult> {
      try {
        const servers = currentMcpServers();
        if (!Object.prototype.hasOwnProperty.call(servers, name)) {
          return `MCP 行 config 无服务器键「${name}」（未添加或已移除）`;
        }
        delete servers[name];
        const report = await deps.apps.configure('mcp', { servers });
        return {
          title: `已移除 MCP 服务器 ${name}`,
          lines: [
            `  ${report.message}`,
            `  servers 键现存 ${Object.keys(servers).length} 个`,
            '生效提示：/reload 后生效；在飞连接随行重载收口。',
          ],
        };
      } catch (err) {
        return `MCP 服务器移除失败：${errText(err)}`;
      }
    },

    appInstallInspect(id: string): DesktopAdminResult {
      const entry = loadCatalog().apps.find((a) => a.id === id);
      if (entry === undefined) return `精选清单无应用「${id}」`;
      return {
        title: `安装确认：${entry.label}（${entry.id}）`,
        lines: [
          `  描述：${entry.description}`,
          `  来源：内置精选（随包 local 直引 ${entry.ref}——审核位：已审）`,
          '  装机管道：appsService.install（D2 既有管道——仓库态零生效）',
          '',
          '装机两态：安装 = 装机物落 <数据目录>/apps + provenance 落账（零生效）；',
          '挂载 = 写组合行（挂应用域）+ /reload 才进装载序。',
        ],
        confirm: {
          label: '确认安装（仓库态零生效）',
          run: () => service.installApp(id),
        },
      };
    },

    async installApp(id: string): Promise<DesktopAdminResult> {
      const entry = loadCatalog().apps.find((a) => a.id === id);
      if (entry === undefined) return `精选清单无应用「${id}」`;
      try {
        // local 直引解析：相对包根的精选 ref → 绝对路径（install 收三源 ref）
        const absRef = join(fileURLToPath(new URL('../../', import.meta.url)), entry.ref);
        const report = await deps.apps.install(absRef);
        return {
          title: `已安装应用 ${report.id}（仓库态·零生效）`,
          lines: [
            `  ${report.message}`,
            `  provenance：sources.json 键 ${entry.id}（local 源绝对直引，已审）`,
            '',
            `挂载后生效：商店视图继续动作（挂载），或 CLI：berry apps mount ${report.id} chat`,
          ],
        };
      } catch (err) {
        return `应用安装失败：${errText(err)}`;
      }
    },

    async mountApp(id: string, apps: readonly string[]): Promise<DesktopAdminResult> {
      if (apps.length === 0) return '挂载目标必填（应用 id，逗号分隔多个 = 共享件）';
      try {
        const report = await deps.apps.mount(id, { apps }); // D2 既有写行动词——禁第二实现
        return {
          title: `已挂载应用 ${report.id}（行写入）`,
          lines: [
            `  ${report.message}`,
            `  挂载目标：${report.apps.join('、')}`,
            '',
            '生效提示：/reload 后进装载序（mount 不自动链重载——动词单职责）。',
          ],
        };
      } catch (err) {
        return `应用挂载失败：${errText(err)}`;
      }
    },
  };
  return service;
}

/**
 * 构造应用商店官方件模块引用（builtins 注册表 `builtin:store` 行——默认层第
 * 十九行，Ring 2 真·可卸）。apply 在行作用域执行一次：inject 三恒在场服务
 * （paths/apps/skills——Kahn 轮次激活等三键就位）+ 构造期注入的用户技能层
 * 定基后 provide `store` 面。服务实例在 apply 内构造（数据目录经 ctx.paths
 * 正规口取——行 config 无关的静态定基）。
 */
export function createStoreApp(deps: StoreAppDeps): BuiltinAppModule {
  return {
    name: 'store',
    inject: ['paths', 'apps', 'skills'],
    apply: (ctx: AppContext) => {
      const paths = ctx.get<StorePathsFace>('paths');
      const service = createStoreService({
        dataDir: paths.dataDir(),
        userSkillsDir: deps.userSkillsDir,
        apps: ctx.get<StoreAppsFace>('apps'),
        skills: ctx.get<StoreSkillsFace>('skills'),
      });
      ctx.provide<StoreService>('store', service);
    },
  };
}
