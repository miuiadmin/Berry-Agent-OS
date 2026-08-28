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
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(repoRoot, 'src');
const distRoot = join(repoRoot, 'dist');

if (!existsSync(distRoot)) {
  console.error('dist/ 不存在——先跑 tsc（npm run build 已按序串接）');
  process.exit(1);
}

/** 递归收集目录下全部 .md 文件（技能资产——子树不含 .md 即返回空） */
function collectMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectMarkdown(full));
    else if (entry.endsWith('.md')) out.push(full);
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
