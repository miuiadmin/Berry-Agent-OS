#!/usr/bin/env node
/**
 * API 面声明产物发射器（契约篇 §6.13.9 dist/api/，第八十七批批 2）。
 *
 * 构建链子步（package.json build 尾段，主 tsc 之后）：产随包 `dist/api/`——
 * - `surface.json`：API 面快照随包位（§6.13.1 快照双位——运行时消费面）；
 * - 六虚拟键 `.d.ts`：api-decls/ 手稳件拷入（berryagent 一行再导出真身 +
 *   llm/sqlite indexed-access 派生 + typebox 三键包转发）；
 * - `tsconfig.paths.json`：应用侧 paths 模板；
 * - 依赖的宿主声明树：tsconfig.api.json 声明发射产 dist/contracts/*.d.ts +
 *   dist/llm/provider-face.d.ts + dist/persist/app-sqlite.d.ts（手稳件的类型锚）。
 *
 * 锚定核验（fail-loud 防手稳件腐）：拷贝后逐条解析 api-decls .d.ts 的相对
 * import 说明符，目标文件不在 dist 树即炸——d.ts 改引用/发射布局变脸当场红，
 * 不留给应用作者在沙盒里撞 unresolved。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（脚本位置上一级） */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 手稳件目录（六键 .d.ts + paths 模板——committed 真源） */
const API_DECLS_DIR = join(REPO_ROOT, 'api-decls');
/** 随包产物目录 */
const DIST_API_DIR = join(REPO_ROOT, 'dist/api');

// —— 步 1：声明发射（tsgo -p tsconfig.api.json——emitDeclarationOnly 子步）——
const tsc = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', 'tsconfig.api.json'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});
if (tsc.status !== 0) {
  console.error('emit-api-decls：tsconfig.api.json 声明发射失败（见上方 tsc 输出）');
  process.exit(1);
}

// —— 步 2：手稳件与快照拷入 dist/api/ ——
mkdirSync(DIST_API_DIR, { recursive: true });
for (const name of readdirSync(API_DECLS_DIR).sort()) {
  if (statSync(join(API_DECLS_DIR, name)).isFile()) {
    cpSync(join(API_DECLS_DIR, name), join(DIST_API_DIR, name));
  }
}
cpSync(join(REPO_ROOT, 'src/contracts/api-surface.json'), join(DIST_API_DIR, 'surface.json'));

// —— 步 3：锚定核验（api-decls .d.ts 的相对 import 逐条解析到 dist 树）——
/** 相对 import 说明符 → dist 内目标路径尝试形（.js → .d.ts；目录 → index.d.ts） */
function resolveDeclTarget(fromDir, spec) {
  if (!spec.startsWith('.')) return null; // 包说明符（typebox/pi-ai）——应用侧 peer 解析，不在此验
  const base = resolve(fromDir, spec);
  const asDecl = base.endsWith('.js') ? base.slice(0, -3) + '.d.ts' : base + '.d.ts';
  if (existsSync(asDecl)) return asDecl;
  return join(base, 'index.d.ts');
}
const anchors = [];
for (const name of readdirSync(DIST_API_DIR).sort()) {
  if (!name.endsWith('.d.ts')) continue;
  const text = readFileSync(join(DIST_API_DIR, name), 'utf8');
  for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = resolveDeclTarget(DIST_API_DIR, m[1]);
    if (target === null) continue;
    if (!existsSync(target)) {
      console.error(
        `emit-api-decls：${name} 相对引用 ${m[1]} 在 dist 树无对应声明（${target}）——` +
          `发射布局或手稳件漂移，先修再发包`,
      );
      process.exit(1);
    }
    anchors.push(`${name} → ${m[1]}`);
  }
}

console.log(
  `emit-api-decls：dist/api/ 就绪（${readdirSync(DIST_API_DIR).length} 文件；锚定核验 ${anchors.length} 条相对引用全过）`,
);
