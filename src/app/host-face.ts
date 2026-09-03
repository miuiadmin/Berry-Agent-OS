/**
 * L5 app — 宿主自省面构建器（API 治理 §6.13.5 ctx.host 的宿主侧数据源，第八十七批）。
 *
 * 两读一派生：
 * - 读包根 package.json 的 `version` / `apiVersion`（fs 直读非 import——tsc 不拷
 *   .json 进 dist，dev〔src/app/〕与 build〔dist/app/〕同为上溯两级到包根，
 *   OFFICIAL_APPS_DIR 同款锚定法）；
 * - 能力清单/实验键清单派生自 contracts/api.ts 目录（CAPABILITIES 按形态过滤、
 *   VIRTUAL_API_KEYS 取 tier=experimental 子集——目录即声明面，不再第二处登记）。
 *
 * 产物 = HostFaceData（纯 JSON 快照）→ materializeHostFace 物化为应用侧只读面。
 * 纯 JSON 形态刻意：worker 域/外部载体桥只传数据不传方法（冷读 m5 桥接档），
 * 对岸各自物化同形面。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES,
  VIRTUAL_API_KEYS,
  isValidApiVersion,
  type FormFactor,
  type HostFace,
  type HostFaceData,
  materializeHostFace,
} from '../contracts/api.js';

/**
 * 包根目录锚定：本文件 dev 形态在 src/app/、build 形态在 dist/app/——两者上溯
 * 两级都到包根（src 与 dist 是平级兄弟，app-registry OFFICIAL_APPS_DIR 同款）。
 */
const PKG_ROOT = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

/** package.json 读缓存（进程寿命——包版本/apiVersion 在进程内不变，boot 期一次读） */
let cachedVersionFields: { version: string; apiVersion: string } | undefined;

/**
 * 读包根 package.json 的版本双字段：version（宿主包版本）+ apiVersion（API 面
 * 版本——§6.13.2 独立号）。缺席/非法即抛——apiVersion 是装载门比较输入，静默
 * 缺席会让一切比较失义（发版事故形态，boot 断言拒启优于带病放行）。
 */
export function readHostVersionFields(): { version: string; apiVersion: string } {
  if (cachedVersionFields !== undefined) return cachedVersionFields;
  const raw = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
    version?: unknown;
    apiVersion?: unknown;
  };
  if (typeof raw.version !== 'string' || raw.version.length === 0) {
    throw new Error('宿主 package.json 缺 version 字段——发布面破损（release 契约 1 应拦）');
  }
  if (typeof raw.apiVersion !== 'string' || !isValidApiVersion(raw.apiVersion)) {
    throw new Error(
      `宿主 package.json apiVersion 非法：${String(raw.apiVersion)}（应为 MAJOR.MINOR 如 "1.0"——API 治理 §6.13.2）`,
    );
  }
  cachedVersionFields = { version: raw.version, apiVersion: raw.apiVersion };
  return cachedVersionFields;
}

/**
 * 构建宿主自省数据快照（HostFaceData）：能力清单按形态过滤（本构建面语义——
 * CAPABILITIES 目录 formFactors 列含当前形态即在场；server 形真实分叉日随构建
 * 差登记），实验键清单 = 键表 tier=experimental 全集（启用与否由装载门声明集
 * 在 import 门禁执法，本面只答「本构建有无此键」）。
 */
export function readHostFaceData(formFactor: FormFactor): HostFaceData {
  const { version, apiVersion } = readHostVersionFields();
  return {
    version,
    apiVersion,
    formFactor,
    capabilities: CAPABILITIES.filter((entry) => entry.formFactors.includes(formFactor)).map((entry) => entry.name),
    experimentalKeys: VIRTUAL_API_KEYS.filter((entry) => entry.tier === 'experimental').map((entry) => entry.key),
  };
}

/**
 * 物化宿主自省面（组合根装配期一次，createContext host 注入物）：宿主与 worker
 * 对岸共用 materializeHostFace 同形构造（桥接纪律 m5——数据随桥走、方法面各岸自派生）。
 */
export function buildHostFace(formFactor: FormFactor): HostFace {
  return materializeHostFace(readHostFaceData(formFactor));
}
