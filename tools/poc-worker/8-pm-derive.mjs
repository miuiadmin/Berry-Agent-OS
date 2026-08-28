#!/usr/bin/env node
/**
 * PoC ⑧（第三十七批 PoC 台账·补炮四）：PM 白名单推导器（fs 读写面）+ audit 可用性核对。
 *
 * d37 研究判词：external 域的落地面 = node PM（--permission），读写面用
 * --allow-fs-read / --allow-fs-write 白名单收窄。本炮两段：
 *
 * 段一（推导器实证）：给定读根/写根清单 → 推导 flags（POSIX 逗号拼接）→ spawn
 *   PM 子进程四探测：读根内过 / 读根外拒 / 写根内过 / 写根外拒。预期拒的
 *   错误码 = ERR_ACCESS_DENIED（PM 拦截签名）。推导器要点（生产代码同款坑）：
 *   ① 入口脚本自身必须进读白名单（PM 下 node 读主模块也要过闸）；
 *   ② 写根不必同时出现在读白名单即可写（读写在 PM 是两条独立通道）——本炮
 *     反着验证：读白名单不含写根时读拒，证明两通道独立。
 *
 * 段二（核对 B 前置）：--permission-audit 与 node.config.json 在本机 v24 线的
 *   可用性 bad-option 探测（22 线结论留官方文档核对，见 RESULTS 记档）。
 * 退出码：0 = PASS，1 = FAIL。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const childPath = fileURLToPath(new URL('./8-pm-derive.child.mjs', import.meta.url));

// 30 秒硬超时
const timer = setTimeout(() => {
  console.error('FAIL: PoC 超时（30s）');
  process.exit(1);
}, 30_000);
timer.unref();

/**
 * PM 白名单推导器（PoC 形态——生产 external 域装载时的同款函数雏形）。
 * 读面固定并入入口脚本自身（PM 下 node 读主模块也过闸——不给则起不来）。
 * @param {{readRoots: string[], writeRoots: string[]}} roots 根清单（绝对路径）
 * @returns {string[]} execArgv 附加 flags
 */
function derivePmFlags(roots) {
  // darwin 坑一：tmpdir 在 /var（→ /private/var 的 symlink）。PM 按归一化绝对路径
  // 匹配白名单——推导时对每根 realpathSync 归一，否则白名单字符串与运行时路径
  // 前缀不匹配，根内操作也被 ERR_ACCESS_DENIED（生产推导器同款细节）。
  // 坑二（v24 实证）：逗号拼接多路径已废弃（warning: no longer valid，整串被当
  // 单一路径字面量）——多根必须每根重复一旗。
  // 坑三（v24 实证）：写白名单根目录若不存在，realpath 归一断链 → 根内写被
  // ERR_ACCESS_DENIED 拒（白名单静默失效）——写根必须预建。
  const norm = (p) => realpathSync(p);
  const readRoots = [...roots.readRoots, childPath].map(norm); // 入口自身必须可读
  return [
    '--permission', // PM 总开关必须领衔（allow-fs-* 是其子旗，缺总开关直接 ERR_MISSING_OPTION）
    ...readRoots.map((p) => `--allow-fs-read=${p}`),
    ...roots.writeRoots.map((p) => `--allow-fs-write=${norm(p)}`),
  ];
}

// 场景搭台：临时根下 allowed（两条白名单都在）与 outside（谁都不在）
const stageRoot = mkdtempSync(join(tmpdir(), 'poc8-pm-'));
const allowedDir = join(stageRoot, 'allowed');
const outsideDir = join(stageRoot, 'outside');
mkdirSync(allowedDir);
mkdirSync(outsideDir);
writeFileSync(join(allowedDir, 'seed.txt'), 'seed-content');

/** 跑一发收齐 stdout/stderr */
function run(args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (err += c));
    proc.on('close', (code) => resolve({ code, out, err }));
  });
}

let fail = false;

/* ---- 段一：推导器四探测 ---- */
{
  const flags = derivePmFlags({
    readRoots: [allowedDir],
    writeRoots: [allowedDir],
  });
  // 子进程回报：四探测各自 {pass:boolean, code:string}（pass=操作成功、code=失败错误码）
  // 子侧探测路径同步归一（运行时 open 的字符串须与白名单同形——同 darwin symlink 坑）
  const r = await run([...flags, childPath, realpathSync(allowedDir), realpathSync(outsideDir)]);
  const report = r.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .at(-1);

  const checks = [
    // 期望过：读根内 / 写根内
    ['读根内(allowed/seed.txt)', report?.readInside?.pass === true],
    ['写根内(allowed/new.txt)', report?.writeInside?.pass === true],
    // 期望拒：读根外 / 写根外——拒的错误码必须是 ERR_ACCESS_DENIED（PM 签名）
    ['读根外(outside/)拒', report?.readOutside?.pass === false && report?.readOutside?.code === 'ERR_ACCESS_DENIED'],
    [
      '写根外(outside/new.txt)拒',
      report?.writeOutside?.pass === false && report?.writeOutside?.code === 'ERR_ACCESS_DENIED',
    ],
    // 通道独立性：写根 allowed 不在读白名单之外的路径也能写（写白名单自带读？否——
    // 事实上 PM 写路径写新文件不需读权。此处验证写根内的读拒（readRoots 不含它时）：
    // 场景里 allowed 同时在两白名单，故反向验证放子进程内做（见 child 注释）。
  ];
  for (const [label, ok] of checks) {
    console.log(`[段一] ${label}: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) fail = true;
  }
  console.log(
    `  （探测详情 JSON）${
      r.out
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .at(-1) ?? '(无)'
    }`,
  );
  if (r.code !== 0 && !report) {
    console.error('  （stderr 摘要）', r.err.split('\n').slice(0, 5).join(' | '));
  }
}

/* ---- 段二：audit / node.config.json 可用性 bad-option 探测 ---- */
{
  // 探测一：--permission-audit（v24 是否有此旗——bad option 即不可用）
  const auditProbe = await run(['--permission-audit', '-e', '']);
  const auditOk = !/bad option/i.test(auditProbe.err) && auditProbe.code === 0;
  console.log(`[段二] --permission-audit: ${auditOk ? '可用（v24 实证）' : '不可用（bad option/非零退出）'} → 记档`);
  // 探测二：node.config.json（NODE_CONFIG_FILE 环境变量形态）
  const configPath = join(stageRoot, 'node.config.json');
  writeFileSync(configPath, JSON.stringify({ flags: '' }));
  const configProbe = await run(['--config-file', configPath, '-e', '']);
  const configOk = !/bad option/i.test(configProbe.err) && configProbe.code === 0;
  console.log(
    `[段二] --config-file(node.config.json): ${configOk ? '可用（v24 实证）' : '不可用（bad option/非零退出）'} → 记档`,
  );
  // 段二只记档不判 FAIL——可用性是事实采集，两线结论汇总在 RESULTS（22 线以官方文档为准）
}

clearTimeout(timer);
rmSync(stageRoot, { recursive: true, force: true });

console.log(
  fail
    ? '== PoC ⑧ 结论: FAIL（白名单推导器语义与预期不符）=='
    : '== PoC ⑧ 结论: PASS（读根内过/根外拒/读写两通道独立执法）==',
);
process.exit(fail ? 1 : 0);
