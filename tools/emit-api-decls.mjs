#!/usr/bin/env node
/**
 * API 面声明产物发射器（契约篇 §6.13.9 dist/api/，第八十七批批 2）。
 *
 * 构建链子步（package.json build 尾段，主 tsc 之后）：产随包 `dist/api/`——
 * - `surface.json`：API 面快照随包位（§6.13.1 快照双位——应用开发者随包参考物，
 *   运行时不读〔装载门/ctx.host 直读 contracts 单源——遗漏大扫 20260904 #14 勘正
 *   回流，API 治理进化批 A4〕）；
 * - 六虚拟键 `.d.ts`：api-decls/ committed 件拷入（berryagent 一行再导出真身 +
 *   llm/sqlite indexed-access 派生〔2026-09-04 进化批刀 D 起由
 *   generate-api-decls.mjs 从 Face 键集生成、check-api 查 8 守护〕+ typebox
 *   三键包转发）；
 * - `tsconfig.paths.json`：应用侧 paths 模板；
 * - 依赖的宿主声明树：tsconfig.api.json 声明发射产 dist/contracts/*.d.ts +
 *   dist/llm/provider-face.d.ts + dist/persist/app-sqlite.d.ts（类型锚）。
 *
 * 两道核验（fail-loud 防腐）：
 * - 锚定核验（步 3）：逐条解析 api-decls .d.ts 的相对 import 说明符，目标文件
 *   不在 dist 树即炸——改引用/发射布局变脸当场红；
 * - 键集双向对账（步 4，刀 D——锚定核验升格）：llm/sqlite 两拷贝件的 declare
 *   键 ⇄ Face 运行时键（jiti 单源，与 loader 注入物同物）双向比——缺键 = Face
 *   加键后漏再生成（第三方作者类型面缺键）；多键 = Face 删键后残留 declare 行
 *   （死面欺骗）。路径可解析 + 内容对账两道齐过才放行。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { declareKeysOf } from './generate-api-decls.mjs';

/** 仓库根（脚本位置上一级） */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 生成物/模板件目录（六键 .d.ts + paths 模板——committed 真源，查 8 守护） */
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

// —— 步 2：committed 生成物与快照拷入 dist/api/ ——
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
          `发射布局或声明件漂移，先修再发包`,
      );
      process.exit(1);
    }
    anchors.push(`${name} → ${m[1]}`);
  }
}

console.log(
  `emit-api-decls：dist/api/ 就绪（${readdirSync(DIST_API_DIR).length} 文件；锚定核验 ${anchors.length} 条相对引用全过）`,
);

// —— 步 4：键集双向对账（刀 D——declare 键 ⇄ Face 运行时键）——
// jiti 载运行时 Face（与 loader 注入物同物——缺省参零副作用）；declare 键识别
// 与 generate-api-decls 单源（declareKeysOf）
const jiti = createJiti(import.meta.url);
const imp = (rel) => jiti.import(fileURLToPath(new URL(rel, import.meta.url)));
const FACE_SOURCES = [
  {
    fileName: 'berryagent-llm.d.ts',
    label: 'providerApiFace',
    rel: '../src/llm/provider-face.ts',
    prop: 'providerApiFace',
  },
  {
    fileName: 'berryagent-sqlite.d.ts',
    label: 'createAppSqliteFace() 产物',
    rel: '../src/persist/app-sqlite.ts',
    factory: 'createAppSqliteFace',
  },
];
let reconciled = 0;
for (const src of FACE_SOURCES) {
  const mod = await imp(src.rel);
  // 运行时键集（缺省参调用零副作用——与抽取器 #1d 同款）
  const runtimeFace = src.prop !== undefined ? mod[src.prop] : mod[src.factory]();
  if (runtimeFace === undefined) throw new Error(`emit-api-decls：${src.rel} 未导出 ${src.prop ?? src.factory}()`);
  const runtimeKeys = Object.keys(runtimeFace).sort();
  const declKeys = declareKeysOf(readFileSync(join(DIST_API_DIR, src.fileName), 'utf8')).sort();
  const missing = runtimeKeys.filter((k) => !declKeys.includes(k));
  const extra = declKeys.filter((k) => !runtimeKeys.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    console.error(
      `emit-api-decls：${src.fileName} declare 键集与 Face 运行时键集漂移（${src.label}）——` +
        `缺 ${missing.join(', ') || '无'} / 多 ${extra.join(', ') || '无'}；` +
        `重跑 node tools/generate-api-decls.mjs --write`,
    );
    process.exit(1);
  }
  reconciled += runtimeKeys.length;
}
console.log(`emit-api-decls：键集双向对账 ${FACE_SOURCES.length} 件全过（declare ${reconciled} 键 ⇄ Face 运行时键）`);
