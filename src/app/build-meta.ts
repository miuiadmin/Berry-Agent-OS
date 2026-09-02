/**
 * dist 构建元数据：读取 + dev 形态陈旧告警（成熟度扫描 20260901 P1-13，规范 =
 * [技术栈]篇 §8.3 契约 3「dist 构建元数据」条）。
 *
 * 动因（探针实测踩中）：npm link 用户 / 本地 node dist 跑者在源码前进后踩
 * stale dist 旧行为（发布侧有兜底——release 契约 3 清 dist 全新 build——但
 * dev 日常形态无人提醒）。修法：build 链尾步写 `dist/.build-meta.json`
 * （tools/write-build-meta.mjs），运行入口 boot 期对照——
 *
 * 告警三前置（全过才 warn，任一失败静默跳过——dev 便利件永不 brick 启动）：
 * ① 入口自身跑在 /dist/ 下（src 直跑/tsx 开发形态无此概念；探测前归一分隔符
 *    ——win32 反斜杠原生形统一转正斜杠，B-2）；
 * ② 包根目录直接含 .git（node_modules 装机形态零 git 探针成本——existsSync
 *    先行，装进他人仓的形态不误报）；
 * ③ `git rev-parse --show-toplevel` === 包根（防「包在他人仓的子目录」形态
 *    拿他人 HEAD 误比对）且 meta.commit ≠ 本仓 HEAD。
 *
 * `--version` 输出形态不变（发布冒烟断言面前缀律维持——元数据不进版本串）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** .build-meta.json 形状：commit = build 时刻源仓 HEAD（git 缺席/失败为 null） */
export interface BuildMeta {
  commit: string | null;
}

/**
 * 读 dist/.build-meta.json：缺席/坏 JSON/形状不符 = null（调用方据此跳过——
 * 元数据是 best-effort 溯源面，坏档不构成启动障碍）。
 */
export function readBuildMeta(distRoot: string): BuildMeta | null {
  const file = join(distRoot, '.build-meta.json');
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    // 形状窄检：commit 位是 string（40 位十六进制）或 null，其余形态视为坏档
    if (parsed === null || typeof parsed !== 'object') return null;
    const commit = (parsed as { commit?: unknown }).commit;
    if (commit === null) return { commit: null };
    if (typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit)) return { commit };
    return null;
  } catch {
    return null; // 坏 JSON——同缺席处理
  }
}

/**
 * git 单发探针：成功返回 trim 后 stdout，失败（git 缺席/非仓/退出码非 0）返回
 * undefined 不抛——告警链路的每一步都是 best-effort。
 */
export function probeGit(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8' });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 告警链路的可注入面：git 探针（测试注入假实现；缺省真跑 probeGit） */
export interface StaleDistProbe {
  /** git 子命令探针：成功返回首行 stdout，失败返回 undefined */
  (args: string[], cwd: string): string | undefined;
}

/**
 * dev 形态陈旧告警（boot 期一次，main.ts 接线）：三前置全过时向 stderr 写
 * 一行 warn 提示重跑 build。全链路 best-effort——任何失败静默返回。
 *
 * @param selfUrl 入口模块的 import.meta.url（判定「跑在 /dist/ 下」+ 定位包根）
 * @param opts.write 输出注入面（缺省 process.stderr.write）——测试直调
 * @param opts.run  git 探针注入面（缺省 probeGit）——测试直调
 */
export function warnIfStaleDist(
  selfUrl: string,
  opts?: { write?: (line: string) => void; run?: StaleDistProbe },
): void {
  const write = opts?.write ?? ((line) => process.stderr.write(line));
  const run = opts?.run ?? ((args, cwd) => probeGit(cwd, args));

  // 前置①：入口跑在 /dist/ 下（余段以 app/ 起头锚定 bin 入口布局 dist/app/main.js
  // ——防用户项目路径自身含 /dist/ 段的误判；首个命中即包边界）
  let filePath: string;
  try {
    filePath = fileURLToPath(selfUrl);
  } catch {
    return; // 非 file: URL——非常规形态，无从判定
  }
  // 分隔符归一（全面复盘 20260902 B-2）：win32 fileURLToPath 得反斜杠原生路径，
  // 正斜杠字面量探针恒 < 0 → 告警链在 Windows 整条静默。统一转正斜杠后探针与
  // 切片同串；pkgRoot/distRoot 以正斜杠形继续传 fs 与 git（两消费面均收正斜杠
  // 形；前置③ git 返回在 win32 亦正斜杠——归一后同形可比）。POSIX 真实路径含
  // 反斜杠是病理性形态，replaceAll 不构成误伤面。
  const normPath = filePath.replaceAll('\\', '/');
  const marker = normPath.indexOf('/dist/app/');
  if (marker < 0) return;
  const pkgRoot = normPath.slice(0, marker);
  const distRoot = `${pkgRoot}/dist`;

  // 前置②：包根直接含 .git（装机形态零 spawn 成本先行筛除）
  if (!existsSync(join(pkgRoot, '.git'))) return;

  // 元数据在场且带 commit 才有对照意义（null = build 时无 git——无从比对）
  const meta = readBuildMeta(distRoot);
  if (meta?.commit === null || !meta) return;

  // 前置③：包根恰为 git 仓根（装进他人仓子目录的形态拿他人 HEAD 误比对）
  const toplevel = run(['rev-parse', '--show-toplevel'], pkgRoot);
  if (toplevel === undefined || toplevel !== pkgRoot) return;

  const head = run(['rev-parse', 'HEAD'], pkgRoot);
  if (head === undefined) return;
  if (head === meta.commit) return; // 新鲜——零输出

  // 陈旧：一行 warn 指路重跑 build（开发指南 §1「跑 dist 前必 build」）
  const short = (sha: string): string => sha.slice(0, 8);
  write(
    `[build] dist 产物落后于源码：build-meta ${short(meta.commit)} ≠ HEAD ${short(head)}——重跑 \`npm run build\`（本地跑 dist 前必 build，开发指南 §1）\n`,
  );
}
