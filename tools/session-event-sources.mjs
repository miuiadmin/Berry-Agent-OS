/**
 * 会话事件宿主面注册模块推导器（API 治理进化批 M5——收割清单单源化）。
 *
 * 原状：durable 事件副作用收割的模块清单存在双拷贝——check-events.mjs 族 3
 * 与 extract-api-surface.mjs #4b 各自手抄导入清单，新增注册模块须两处同步
 * （漏一处即闸误报/面漏收）。本模块以**源码双合取判据**机器推导清单取而代之
 * （零维护——新增注册模块自动入两消费面扫描面）：
 *
 * - P1 名绑定值导入：`import { … registerSessionEventType … } from '…/session-events.js'`
 *   ——值导入该符号本身。`import type { SessionEventTypeDefinition }`（类型面）
 *   与 `registerAppSessionEventType`（邻名不同符号）均不匹配；
 * - P2 非成员调用形：`(?<![.\w])registerSessionEventType\s*\(`——排除
 *   `ctx.registerSessionEventType(` 成员调用（装载面，运行时态）；interface
 *   方法签名/对象方法定义形由 P1 收口（定义位文件不值导入该符号）。
 *
 * 推导面：src/ 树全部 .ts（排除 .test.ts 测试面豁免、排除符号链接）；目录
 * 缺席 = 空集。**推导集为空即炸**：真树结构性恒有 contracts/deprecations.ts
 * 在集（废弃机器件），空集 = 判据漂移（符号改名/导入形变），fail-loud 好过
 * 静默漏收割。双入口边界不变：本推导只覆盖宿主面（模块级注册直调）——装载面
 * ctx.registerSessionEventType 注册发生在 apply 运行时、CI 静态不可见
 * （会话篇 §2.1 注记）。
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件在 tools/ 下） */
export const REPO_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));

/** P1：名绑定值导入 registerSessionEventType（多行 m——import 语句可在文件任意行） */
const VALUE_IMPORT_RE =
  /^import\s+\{[^}]*\bregisterSessionEventType\b[^}]*\}\s+from\s+['"][^'"]*\/session-events(\.js|\.ts)?['"]/m;

/** P2：非成员调用形（前置不接 . 或词字符——成员调用/属性引用排除） */
const CALL_FORM_RE = /(?<![.\w])registerSessionEventType\s*\(/;

/**
 * 递归收集目录下 .ts 文件（root 绝对根；rel 相对根路径；跳过 node_modules/
 * .git/dist 与符号链接——与 check-api.mjs walkFiles 同纪律）。
 * @returns {string[]} root 相对路径全集（含目录缺席 = 空集）
 */
function walkTsFiles(root, rel, out = []) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs).sort()) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const sub = rel === '' ? name : `${rel}/${name}`;
    const full = join(root, sub);
    // lstat 不解析链接：链接实体一律跳过（环链 ELOOP 防护同款）
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walkTsFiles(root, sub, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(sub);
  }
  return out;
}

/**
 * 推导宿主面会话事件注册模块清单（双合取判据见模块头注）。
 * @param {string} [root] 扫描根（缺省 = 仓库根；测试以夹具树参数化）
 * @returns {string[]} root 相对路径（'src/…events.ts' 形，排序稳定）
 */
export function discoverSessionEventRegistrars(root = REPO_ROOT) {
  const found = [];
  // 扫描面 = src/ 子树（宿主面注册模块的物理位；测试文件与符号链接排除）
  for (const rel of walkTsFiles(root, 'src')) {
    const text = readFileSync(join(root, rel), 'utf8');
    if (VALUE_IMPORT_RE.test(text) && CALL_FORM_RE.test(text)) found.push(rel);
  }
  // 空集防线：真树结构性恒含 contracts/deprecations.ts（废弃机器件在册）——
  // 空集即判据漂移（符号改名/导入形变），炸出来看不静默漏收割
  if (found.length === 0) {
    throw new Error(
      '宿主面注册模块推导为空——判据漂移？（检查 registerSessionEventType 符号名与 session-events 导入形是否变更）',
    );
  }
  return found.sort();
}
