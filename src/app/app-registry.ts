/**
 * L5 app — 官方应用注册表（契约篇 §5.4 应用面第二纵切，2026-08-25 落码）。
 *
 * 应用清单发现面两分（冷读裁决，类推 skills）：
 * - **官方清单** = 宿主包内静态已知（仓库根 `apps/*.app.yaml`），装载期直接
 *   解析——本文件职责；解析/校验失败 = 启动断言拒启（官方件随包，坏 = 发版事故，
 *   宁拒绝不误读）；
 * - **第三方清单** = `harness.apps` glob 装机期发现面——挂账随 ctx.apps
 *   install 落地（冷读钉死：不引用组合树 §6.2 机制，skills 装机期先例同构）。
 *
 * 组件在场断言（components 在场断言）：按**装载身份串**（`builtin:<name>` /
 * npm 包名 = 组合树行 plugin 字段的值域）匹配激活行；缺场 = 应用级隔离
 * （应用不可用但宿主照启——与「失败行 boot 拒启」的失败语义刻意分层：清单是
 * 声明面，声明了没装的组件是用户裁量不是发行事故）。诊断出口 = dump-config
 * 打印 + debug 日志（app/* 自有事件词汇 2026-08-27 再议裁决：v1 不落——进入
 * 事实已由三面承载〔sessions 表 app 列 durable / request·header 载荷 app 腿
 * durable / /app notify 交互面——契约篇 §5.4 同名裁决〕，重开触发 = 首个需
 * 实时感知应用装载态的应用消费者）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { AppError, APP_DUPLICATE, APP_INVALID, APP_NOT_FOUND } from '../contracts/errors.js';
import { validateAppManifest, type AppManifest } from '../contracts/app.js';
import { CHAT_APP_ID } from '../chat/app.js';
import type { SubagentStart } from '../contracts/subagent.js';
import type { CompositionReport } from './composition.js';

/**
 * 官方清单目录（仓库根 `apps/`——与 src/ 平级）。锚定经 import.meta.url：
 * dev（src/app/）与 build（dist/app/）同为上溯两级到包根（src 与 dist 是
 * 平级兄弟）；发布包形态随分发批（第十七批 npm 三源）加 files 拷贝，当前
 * private 包零额外动作。
 */
export const OFFICIAL_APPS_DIR = fileURLToPath(new URL('../../apps', import.meta.url));

/** 清单文件后缀（约定命名 `<id>.app.yaml`——id 以清单内容为准，文件名仅人读） */
const MANIFEST_SUFFIX = '.app.yaml';

/**
 * 装载官方应用清单（装载期一次；目录缺失 = 空表防御降级，清单坏 = 抛错拒启）。
 * @param dir 清单目录（缺省官方目录；测试注入临时目录）
 * @returns id → 清单（id 重复 = APP_DUPLICATE——官方裸名是保留字，撞名即发版事故）
 */
export function loadOfficialApps(dir: string = OFFICIAL_APPS_DIR): Map<string, AppManifest> {
  // 目录缺失：空表（防御位——仓库布局恒有 apps/；不因布局异常炸启动面）
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return new Map();
  }
  const apps = new Map<string, AppManifest>();
  for (const name of entries.sort()) {
    if (!name.endsWith(MANIFEST_SUFFIX)) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    // yaml 解析失败与 schema 校验失败同抛 APP_INVALID（统一出口，message 载文件路径）
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new AppError(
        APP_INVALID,
        `${path}：应用清单 yaml 解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const manifest = validateAppManifest(doc, path);
    if (apps.has(manifest.id)) {
      throw new AppError(
        APP_DUPLICATE,
        `应用 id 撞名：${manifest.id}（${path} 与既有清单重复——官方裸名是保留字，撞名即发版事故）`,
      );
    }
    apps.set(manifest.id, manifest);
  }
  /* 默认应用键唯一性执法（组装批，契约篇 §5.4 默认应用键条款）：在册全量
   * （注册期先于缺场隔离——缺场只影响解析结果不影响执法）多于一份带标清单 =
   * APP_INVALID 拒。官方清单注册期拒 = boot 拒启（官方件随包，>1 = 发版事故，
   * 宁拒绝不误读——与本函数其余执法同律）。 */
  const marked = [...apps.values()].filter((m) => m.default === true);
  if (marked.length > 1) {
    throw new AppError(
      APP_INVALID,
      `默认应用声明冲突：${marked.map((m) => m.id).join('、')} 均带 default: true（全局唯一属性，恰一带标——修改其余清单的 default 键）`,
    );
  }
  /* 装载表按 id 字母序定序：文件名仅人读（MANIFEST_SUFFIX 头注——id 以清单内容
   * 为准），排序基准同为 id。若按文件名序入表（readdir+文件名 sort），文件名与
   * id 不同名的中间态（重命名战役文件名先行）会让文件名序牵动一切用户可见序
   * （APP_NOT_FOUND 在册披露行 / /app 可用应用行）——两序错位即测试红（CI 实证）。
   * 按 id 定序后装载表序只随 id 走，文件名怎么改都不外露。 */
  const ordered = [...apps.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(ordered.map((m) => [m.id, m]));
}

/**
 * 默认应用解析（组装批，契约篇 §5.4 默认应用键条款——per-open 活取的纯函数半边）。
 *
 * 解析序两跳 + 兜底态：① 在场（不在缺场表）且带标清单 → 默认；② 回落 `chat`
 * （对话应用语义上是默认入口的常任兜底——卸默认应用后系统仍有可对话入口；
 * 回落要求 chat 本身在场）；③ 两跳皆断 → undefined = **默认解析无果**（兜底态：
 * 调用方防御降级——TUI 无驱动起屏 + warn / run 退 1，不认领任意在册应用、
 * 不静默换域）。缺场判定输入 = assertAppComponents 产物（缺场随当下组合树
 * 投影——/reload 换件后即时反映于下一次 open）。
 *
 * @param apps 官方清单表（loadOfficialApps 产物——恰一执法已在装载期完成）
 * @param gaps 组件缺场表（assertAppComponents 产物；调用方闭包读活值即 per-open 活取）
 */
export function resolveDefaultApp(
  apps: ReadonlyMap<string, AppManifest>,
  gaps: ReadonlyMap<string, readonly string[]>,
): AppManifest | undefined {
  // 第一跳：带标且在场（零标记清单不走此跳——回落链第二跳）
  for (const m of apps.values()) {
    if (m.default === true && !gaps.has(m.id)) return m;
  }
  // 第二跳：回落 chat（在场即可；CHAT_APP_ID 住 chat 件——app→chat 拓扑边既有）
  const chat = apps.get(CHAT_APP_ID);
  return chat !== undefined && !gaps.has(chat.id) ? chat : undefined;
}

/**
 * 组件在场断言（装载期——post-apply 时点，组合树已合成）。
 *
 * 匹配键 = 装载身份串：组合树**激活行**的 pkg 字段值域（`builtin:chat` /
 * npm 包名）。不按组合树行 id（行 id 是实例标识可任意命名）、不按 module.name
 * （jiti 命名空间穿透实证不可信——加载器形状校验同教训）。「激活」= 计划行
 * 无 skip 且无 unresolved（装载失败行已由 boot 断言拦截，到不了这里）。
 *
 * 在场值域（D1 清单投影批升级，契约篇 §5.1）：**挂全局 ∪ 挂本应用**——行
 * `apps` 键缺省（挂全局作用域）对该组件的一切声明应用都算在场；行 `apps: [<别应用>]`
 * 只对目标应用算在场（挂他应用 ≠ 在场——能力进了别应用作用域，本应用不可用，
 * 缺场照报）。同一身份串多行并存（overlay 复挂）按挂载域并集判定。
 *
 * @param apps 官方清单表
 * @param composition 组合树装载产物
 * @returns id → 缺失组件清单（空清单 = 完整；调用方落 debug 日志与 dump-config）
 */
export function assertAppComponents(
  apps: ReadonlyMap<string, AppManifest>,
  composition: CompositionReport,
): Map<string, readonly string[]> {
  // 激活行的装载身份串 → 挂载域集合（undefined 元素 = 挂系统行；字符串元素 =
  // 挂该应用的行——D1 前单集合不分域，挂任何位置都算在场）
  const refDomains = new Map<string, Set<string | undefined>>();
  const planById = new Map(composition.plan.map((row) => [row.id, row]));
  for (const row of composition.rows) {
    if (row.pkg === undefined) continue;
    const plan = planById.get(row.id);
    if (plan === undefined || plan.skip !== undefined || plan.unresolved !== undefined) continue;
    let domains = refDomains.get(row.pkg);
    if (domains === undefined) {
      domains = new Set<string | undefined>();
      refDomains.set(row.pkg, domains);
    }
    // 在场域集（第三十六批 apps 数组化）：行挂多应用 = 组件在该多应用域皆在场
    //（一行投多 app）；apps 键缺席 = 全局作用域（undefined 域——一切应用皆在场）
    if (row.apps === undefined) domains.add(undefined);
    else for (const appId of row.apps) domains.add(appId);
  }
  const gaps = new Map<string, readonly string[]>();
  for (const [id, manifest] of apps) {
    // 缺场 = 该身份串无任何激活行，或激活行全挂别应用（挂系统/挂本应用即在场）
    const missing = manifest.components.filter((ref) => {
      const domains = refDomains.get(ref);
      return domains === undefined || !(domains.has(undefined) || domains.has(id));
    });
    if (missing.length > 0) gaps.set(id, missing);
  }
  return gaps;
}

/**
 * 进入面应用解析（第三纵切，契约篇 §5.4 第 2 条）：CLI `--app` / TUI `/app <id>`
 * 的 id → 清单解析。查无 = APP_NOT_FOUND（message 披露在册可用清单——自助排错，
 * 与虚拟面撞错附清单同纪律）；查有即返回清单（进入路径自行做组件在场检查——
 * 缺场应用走应用级隔离语义，不在此码）。
 *
 * @param apps 官方清单表（loadOfficialApps 产物）
 * @param id 应用 id（进入面用户输入）
 */
export function resolveApp(apps: ReadonlyMap<string, AppManifest>, id: string): AppManifest {
  const manifest = apps.get(id);
  if (manifest !== undefined) return manifest;
  const available = [...apps.keys()].join('、');
  throw new AppError(
    APP_NOT_FOUND,
    `未知应用：${id}${available === '' ? '（在册应用：无——组合树空装或清单目录空）' : `（在册应用：${available}）`}`,
  );
}

/**
 * delegable 应用的委派请求合并钩子（第三纵切，契约篇 §5.4 第 2 条委派形态）：
 * 把清单 agent 段作为静态半边注入委派请求——语义与声明式 agents/*.md 同款
 * （inprocess.mergeRequest 消费）：persona 钉死（应用人格是身份不是偏好）、
 * toolFilter 交集（两侧白名单同时执法——请求未给名单 = 全量 → 用清单名单）、
 * model 覆盖（装配默认位钉死引擎）。合并只收窄不改宽，能力协商在合并前已过。
 *
 * @param manifest 应用清单（agent 段缺席 = 恒等合并——纯清单应用委派裸跑）
 */
export function mergeRequestForApp(manifest: AppManifest): (request: SubagentStart) => SubagentStart {
  const agent = manifest.agent;
  if (agent === undefined) return (request) => request;
  return (request) => ({
    ...request,
    ...(agent.persona !== undefined ? { persona: agent.persona } : {}),
    ...(agent.toolFilter !== undefined
      ? {
          // 请求侧未给名单 = 全量 → 用清单名单；给了 = 交集（两侧白名单同时执法）
          toolFilter:
            request.toolFilter === undefined
              ? agent.toolFilter
              : agent.toolFilter.filter((tool) => request.toolFilter!.includes(tool)),
        }
      : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
  });
}
