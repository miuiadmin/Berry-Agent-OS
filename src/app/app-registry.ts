/**
 * L5 app — 官方应用注册表（契约篇 §5.4 应用面第二纵切，2026-08-25 落码）。
 *
 * 应用清单发现面两分（冷读裁决，类推 skills）：
 * - **官方清单** = 宿主包内静态已知（仓库根 `apps/*.app.yaml`），装载期直接
 *   解析——本文件职责；解析/校验失败 = 启动断言拒启（官方件随包，坏 = 发版事故，
 *   宁拒绝不误读）；
 * - **第三方清单** = `harness.apps` glob 装机期发现面——挂账随 ctx.plugins
 *   install 落地（冷读钉死：不引用组合树 §6.2 机制，skills 装机期先例同构）。
 *
 * 组件在场断言（components 在场断言）：按**装载身份串**（`builtin:<name>` /
 * npm 包名 = 组合树行 plugin 字段的值域）匹配激活行；缺场 = 应用级隔离
 * （应用不可用但宿主照启——与「失败行 boot 拒启」的失败语义刻意分层：清单是
 * 声明面，声明了没装的组件是用户裁量不是发行事故）。诊断出口 = dump-config
 * 打印 + debug 日志（app/* 事件词汇随第三纵切 /app 面）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { AppError, APP_DUPLICATE, APP_INVALID } from '../contracts/errors.js';
import { validateAppManifest, type AppManifest } from '../contracts/app.js';
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
  return apps;
}

/**
 * 组件在场断言（装载期——post-apply 时点，组合树已合成）。
 *
 * 匹配键 = 装载身份串：组合树**激活行**的 plugin 字段值域（`builtin:chat` /
 * npm 包名）。不按组合树行 id（行 id 是实例标识可任意命名）、不按 module.name
 * （jiti 命名空间穿透实证不可信——加载器形状校验同教训）。「激活」= 计划行
 * 无 skip 且无 unresolved（装载失败行已由 boot 断言拦截，到不了这里）。
 *
 * @param apps 官方清单表
 * @param composition 组合树装载产物
 * @returns id → 缺失组件清单（空清单 = 完整；调用方落 debug 日志与 dump-config）
 */
export function assertAppComponents(
  apps: ReadonlyMap<string, AppManifest>,
  composition: CompositionReport,
): Map<string, readonly string[]> {
  // 激活行的装载身份串集合：合成行携带 plugin 字段，计划行携带 skip/unresolved
  const activeRefs = new Set<string>();
  const planById = new Map(composition.plan.map((row) => [row.id, row]));
  for (const row of composition.rows) {
    if (row.plugin === undefined) continue;
    const plan = planById.get(row.id);
    if (plan === undefined || plan.skip !== undefined || plan.unresolved !== undefined) continue;
    activeRefs.add(row.plugin);
  }
  const gaps = new Map<string, readonly string[]>();
  for (const [id, manifest] of apps) {
    const missing = manifest.components.filter((ref) => !activeRefs.has(ref));
    if (missing.length > 0) gaps.set(id, missing);
  }
  return gaps;
}
