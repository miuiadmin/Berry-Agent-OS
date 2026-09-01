#!/usr/bin/env node
/**
 * 构建资产拷贝（tsc 后置步骤）：把 src 内应用技能资产（SKILL.md 等 .md 文件）
 * 递归拷到 dist 镜像路径——tsc 只编译 .ts，非代码资产默认不落 dist。
 *
 * 为什么需要：官方 builtin 件随包携带技能（admin 件先例——packageRoot 自述
 * `dirname(fileURLToPath(import.meta.url))`，dist 侧即 dist/<模块>/……，其
 * skills 子树里的 SKILL.md 必须在 dist 侧同样存在，否则 npm 安装后技能
 * 注册静默落空）。tsx dev 直读 src 无需拷贝——本脚本只挂 build。
 *
 * 规则：只拷 .md（SKILL.md 与技能正文文档），目录结构原样镜像；源侧不存在的
 * 目录跳过（未来新增带技能件自动覆盖，无需改本脚本）。
 *
 * 尾步二件（2026-09-02 成熟度扫描快赢#4）：bin 执行位——npm 安装期会自动修
 * bin 权限，但手动解包 tarball 形态无人修；build 时把 0755 打进产物，tarball
 * 自含正确形态（bin 入口缺席 = 构建形态漂移，fail-loud 同本脚本既有姿态）。
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(repoRoot, 'src');
const distRoot = join(repoRoot, 'dist');

if (!existsSync(distRoot)) {
  console.error('dist/ 不存在——先跑 tsc（npm run build 已按序串接）');
  process.exit(1);
}

/** 递归收集目录下全部 .md 文件（技能资产——子树不含 .md 即返回空；webui/client 排除：SPA 源树非技能资产域） */
function collectMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (full === join(srcRoot, 'webui', 'client')) continue;
      out.push(...collectMarkdown(full));
    } else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = collectMarkdown(srcRoot);
for (const file of files) {
  const target = join(distRoot, relative(srcRoot, file));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(file, target);
}

console.log(
  `技能资产拷贝完成：${files.length} 个 .md → dist 镜像${files.length > 0 ? '' : '（src 内暂无——空转合法）'}`,
);

// bin 执行位（快赢#4）：package.json bin.berry 指向 dist/app/main.js——tsc 产出
// 无执行位（0644），npm 安装期 npm 会自动修，但手动解包 tarball（curl tarball |
// tar xz 形态）无人修；build 时打进 0755 使 tarball 自含正确权限位。
// 入口缺席 = tsc 输出形态漂移（bin 指向不存在文件），fail-loud 拒静默。
const binEntry = join(distRoot, 'app', 'main.js');
if (!existsSync(binEntry)) {
  console.error(`bin 入口缺席：${binEntry}（package.json bin 指向该文件——tsc 输出形态漂移？）`);
  process.exit(1);
}
chmodSync(binEntry, 0o755);
console.log('bin 执行位已设：dist/app/main.js → 0755（tarball 手动解包形态自含可执行）');
