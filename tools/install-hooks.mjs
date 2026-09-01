#!/usr/bin/env node
/**
 * 钩子安装器（基建大扫 20260901 #20）——把 git 钩子查找路径指到仓库内
 * .githooks/（core.hooksPath），零新增依赖（husky/lefthook 等均已否决——
 * 「已退役勿重新引入」同款立场，手写小脚本先例 = release.mjs）。
 *
 * 接线机制：package.json "prepare" 生命周期脚本调起本文件——开发者
 * `npm install` 即自动安装；钩子本体住仓库 .githooks/pre-commit（四门禁
 * 提交时刻执法），随版本演进不落各机器 .git/hooks 陈旧副本。
 *
 * 双场景行为（回归锁见 tools/gates-infra.test.mjs）：
 * - git 仓内：git config core.hooksPath .githooks（幂等——重复跑即覆写）；
 * - 非 git 目录（消费者装包 / 异常环境）：打印一行说明后静默退出 0，
 *   绝不让 npm install 因钩子面炸掉——prepare 在 npm install 路径上，
 *   失败即装包失败。
 */

import { spawnSync } from 'node:child_process';

/** 在 cwd 起 git 查询：返回 [成功与否, stdout 尾去空白] */
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return [r.status === 0, String(r.stdout ?? '').trim()];
}

// 场景面探针：不在 git 仓（.git 缺席 / git 不可用）→ 静默 0（见文件头注释）
const [inRepoOk] = git(['rev-parse', '--git-dir']);
if (!inRepoOk) {
  console.log('（非 git 仓环境——跳过钩子安装）');
  process.exit(0);
}

// 仓根定位：钩子查找路径是相对仓根解析的（git 语义），从任意子目录跑也钉对位置
const [rootOk, root] = git(['rev-parse', '--show-toplevel']);
if (!rootOk || root === '') {
  // rev-parse --git-dir 成功而 --show-toplevel 失败的形态：裸仓等无工作树
  console.log('（无工作树 git 环境（bare repo）——跳过钩子安装）');
  process.exit(0);
}

// 接线：core.hooksPath 指到仓内 .githooks（幂等覆写；git 在找不到该目录下
// 对应钩子时静默跳过，不构成硬依赖）
const [cfgOk] = git(['config', 'core.hooksPath', '.githooks']);
if (!cfgOk) {
  console.log('（core.hooksPath 设置失败——git config 非零退出，跳过钩子安装）');
  process.exit(0);
}
console.log('钩子已安装：core.hooksPath → .githooks（提交前四门禁执法）');
