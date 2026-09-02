/**
 * build 链尾步：写 dist/.build-meta.json（成熟度扫描 20260901 P1-13，规范 =
 * [技术栈]篇 §8.3 契约 3「dist 构建元数据」条）。
 *
 * 形状 = `{ "commit": "<HEAD>" }`——build 时刻源仓 git HEAD；git 缺席/失败写
 * `null` 不炸 build（元数据是溯源便利件，不是发布前置）。发布物 files 含 dist
 * 整目录自然随包；装机产物内它作溯源面，dev 仓内它供运行入口陈旧告警对照
 * （src/app/build-meta.ts——跑 dist 前忘 build 的旧行为踩坑防线）。
 *
 * DIST_ROOT 环境变量 = 根缝（CHECK_ROOT 同款惯例）：测试注入临时目录，
 * 缺省写本仓 dist/。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本仓根（脚本在 tools/ 下——git 探针的 cwd 锚定仓根，不随调用方 cwd 漂移） */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** dist 根：DIST_ROOT 根缝优先，缺省本仓 dist/ */
const distRoot = process.env.DIST_ROOT ? resolve(process.env.DIST_ROOT) : join(repoRoot, 'dist');

/** 源仓 HEAD（40 位十六进制）；git 缺席/非仓/失败 = null（best-effort，不炸 build） */
let commit = null;
try {
  const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  commit = out.trim() || null;
} catch {
  // git 缺席 / 非 git 环境（如某些 CI 精检容器）——null 保留，运行侧对照自然跳过
}

mkdirSync(distRoot, { recursive: true });
writeFileSync(join(distRoot, '.build-meta.json'), `${JSON.stringify({ commit }, null, 2)}\n`);
