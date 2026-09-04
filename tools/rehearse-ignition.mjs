#!/usr/bin/env node
/**
 * 收剑点火演练机器（契约篇 §6.13.4 ④ 演练预演——API 治理进化批刀 O）。
 *
 * 点火 = 不可逆高险单点动作（`API_ENFORCEMENT_IGNITED` 翻 true：api 块缺席从
 * 聚合 warn 变拒载、min fail-loud 对全体应用生效）——release 机器
 * `--dry-run`/`--inject` 的点火对位物：点火日翻常量之前必经本演练，不留
 * 无预演通道。模拟 ignited 树 = 临时 detached git worktree（HEAD 检出 +
 * node_modules 符号链接——主工作区零接触，兄弟 session 并发面无扰）内单点
 * 翻常量后跑连锁链，验证五连锁面零意外红：
 *
 * - 连锁面一（快照纪元章）：面抽取 --write 再生后快照顶层 enforcement === 'ignited'；
 * - 连锁面二（两生成物纪元渲染）：COMPATIBILITY.md 头部当前纪元行变 ignited
 *   （API参考不渲染纪元——面不变即字节不动，属预期）；
 * - 连锁面三（api 块翻必填）：点火日**第二动作**（清单 schema 动作非常量翻转）
 *   ——演练范围仅常量翻转腿（细则③），本机器只打印动作清单指路不代跑；
 * - 连锁面四（装载门 legacy 出口消失）：以单测两态注入覆盖（细则③——
 *   src/contracts/api.test.ts「收剑点火位」describe，缺块拒载腿在场即证）；
 * - 连锁面五（PR 闸 api-break: 标签义务）：演练树内临时 commit → PR 闸
 *   --base 原 sha 两跑——无标签 exit 1 点名裁决标签义务 / 带 api-break: exit 0。
 *
 * 演练四细则（§6.13.4 ④，冷读 CR2 收口）对位：
 * - 细则① 正证腿：先面抽取 --write 再生快照（对齐点火日动作清单）再 check-api 全绿；
 * - 细则② 负证腿：不再生快照对照跑 check-api——预期红清单显式枚举 = 恰 [查 1]
 *   （生成器真值源是提交位快照非常量，查 8 不受常量翻转影响——单查 1 红为
 *   规范原文精确形态）；预期红缺席或此外任何红 = 意外红，演练失败；
 * - 细则③ 见连锁面三/四注记；
 * - 细则④ 本机器不裸调 adjudicateApiGate（裸调炸进程非优雅红）——装载门
 *   行为面交单测，本机器只跑静态机器链。
 *
 * 用法：`node tools/rehearse-ignition.mjs`（点火日全量形态：+ typecheck +
 * 面相关测试两重腿）；`node tools/rehearse-ignition.mjs --core`（跳过两重腿
 * ——vitest 回归锁形态，核心五连锁腿不变）。常量已点火（true）时绿退场：
 * 演练仅适用于点火前，点火日之后本机器结构性退役。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件在 tools/ 下） */
const REPO_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));

/** 常量声明行（唯一翻转位——出现次数 ≠ 1 即形状漂移 fail-loud） */
const IGNITED_DECL = 'export const API_ENFORCEMENT_IGNITED = ';

/**
 * 单点翻转纯函数（测试面直锁）：`API_ENFORCEMENT_IGNITED = false` → `true`。
 * 恰一处才翻——零处（已点火/改名/改形）或不止一处（散拷进场）都炸，不留
 * 「翻了个寂寞」或「翻半棵树」的静默通道。
 * @param {string} src api.ts 源文件全文
 * @returns {string} 翻转后源文
 */
export function flipIgnitionConstant(src) {
  const from = `${IGNITED_DECL}false;`;
  const to = `${IGNITED_DECL}true;`;
  const count = src.split(from).length - 1;
  if (count !== 1) {
    throw new Error(
      `翻转位形状漂移：API_ENFORCEMENT_IGNITED = false 声明出现 ${count} 次（期望恰 1——已点火/改名/散拷均事故，fail-loud）`,
    );
  }
  return src.replace(from, to);
}

/**
 * 从 check-api 输出收红清单（测试面直锁）：收全部 `[查 N]`/`[查 Nc]` 命中号
 * 去重排序——负证腿的预期红枚举对照面。
 * @param {string} text stderr+stdout 合并文本
 * @returns {string[]} 去重排序后的查号（如 ['1', '3c']）
 */
export function parseCheckReds(text) {
  const ids = new Set();
  for (const m of text.matchAll(/\[查 (\d+[a-z]?)]/g)) ids.add(m[1]);
  return [...ids].sort();
}

/**
 * 从 vitest 输出收失败测试题名（测试面直锁）：`× <title>` 行剥尾部耗时——
 * 面相关测试腿的预期红（同笔测试清单）枚举对照面。
 * @param {string} text vitest run 输出全文
 * @returns {string[]} 失败测试题名全集
 */
export function parseFailedTitles(text) {
  const titles = [];
  for (const m of text.matchAll(/^\s*× (.+?)\s*\d*m?s\s*$/gm)) titles.push(m[1]);
  return titles;
}

/** 子进程环境净化：剥 CHECK_API_ 前缀 / GIT_ 前缀 / BASE_SHA / LABELS（夹具缝与钩子泄漏面——演练必须看到真面真仓） */
function childEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CHECK_API_') || k.startsWith('GIT_') || k === 'BASE_SHA' || k === 'LABELS') continue;
    out[k] = v;
  }
  return out;
}

/** 单步跑子进程（失败即 throw 带名 stderr——演练的每步都是断言，红即终局） */
function run(cwd, cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: childEnv() });
  if (r.status !== 0) {
    throw new Error(`[${label}] 失败（exit ${r.status}）：${r.stderr || r.stdout}`);
  }
  return r;
}

/* ---------------- CLI 主链 ---------------- */

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const coreOnly = process.argv.includes('--core');
  const apiTsPath = join(REPO_ROOT, 'src', 'contracts', 'api.ts');
  const apiTs = readFileSync(apiTsPath, 'utf8');

  // 前置：常量现役态分诊——已点火（true）= 演练结构性退役，绿退场不失败
  if (apiTs.includes(`${IGNITED_DECL}true;`)) {
    console.log('[演练] 常量已点火（API_ENFORCEMENT_IGNITED = true）——演练仅适用于点火前，绿退场（本机器至此退役）。');
    process.exit(0);
  }
  if (!apiTs.includes(`${IGNITED_DECL}false;`)) {
    console.error(`[演练] 前置失败：src/contracts/api.ts 无现役 false 声明（形状漂移——先修常量声明形再演练）。`);
    process.exit(1);
  }
  console.log('[演练 0] 前置：常量现役 false（点火前窗口容忍态）✓');

  // 主仓 HEAD（worktree 检出锚 + PR 闸 --base 锚——先取后建，两锚同 sha 消竞速）
  const origSha = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: childEnv(),
  }).stdout.trim();
  const wt = mkdtempSync(join(tmpdir(), 'rehearse-ignition-'));
  // 前次崩溃残迹清册（worktree 元数据悬置不影响本次 add，但清了干净）
  spawnSync('git', ['worktree', 'prune'], { cwd: REPO_ROOT, env: childEnv() });

  try {
    // 隔离树：detached worktree @HEAD + node_modules 符号链接（tools 链 jiti/typebox
    // 等依赖经链接解析真 node_modules——worktree 不复制依赖，秒级建树）
    const g = (args) => run(REPO_ROOT, 'git', args, 'worktree');
    g(['worktree', 'add', '--detach', '--quiet', wt, origSha]);
    if (!existsSync(join(REPO_ROOT, 'node_modules'))) {
      throw new Error('[演练 1] 主仓 node_modules 缺席——先 npm install（演练树经符号链接复用真依赖）');
    }
    symlinkSync(resolve(REPO_ROOT, 'node_modules'), join(wt, 'node_modules'), 'dir');
    console.log(`[演练 1] 隔离树：${wt}（HEAD ${origSha.slice(0, 8)}）+ node_modules 符号链接 ✓`);

    // 单点翻常量（flipIgnitionConstant 恰一处断言在内——零处/散拷即炸）
    const wtApiTs = join(wt, 'src', 'contracts', 'api.ts');
    const flipped = flipIgnitionConstant(readFileSync(wtApiTs, 'utf8'));
    writeFileSync(wtApiTs, flipped);
    console.log('[演练 2] 单点翻常量：API_ENFORCEMENT_IGNITED false → true（恰 1 处）✓');

    /* -------- 负证腿（细则②）：不再生快照对照跑——预期红恰 [查 1] -------- */
    const leg2 = spawnSync(process.execPath, [join('tools', 'check-api.mjs')], {
      cwd: wt,
      encoding: 'utf8',
      env: childEnv(),
    });
    const reds = parseCheckReds(leg2.stderr + leg2.stdout);
    const EXPECTED_LEG2_REDS = ['1']; // 预期红清单显式枚举（规范原文「单查 1 红」）
    const unexpected = reds.filter((id) => !EXPECTED_LEG2_REDS.includes(id));
    if (leg2.status !== 1 || !reds.includes('1')) {
      throw new Error(
        `[负证腿] 预期红缺席：不再生快照时查 1 应红（exit=${leg2.status}，红清单=[${reds.join(', ')}]）——` +
          `快照纪元章或查 1 机制漂移（连锁面断裂，点火日真实翻转会同样静默）`,
      );
    }
    if (unexpected.length > 0) {
      throw new Error(
        `[负证腿] 意外红：预期红清单 = [查 1] 而实得 [${reds.join(', ')}]——意外红 = 此外一切（细则②），逐项排查后再演练`,
      );
    }
    console.log('[负证腿] check-api 不再生快照 → exit 1，红清单 = [查 1]（预期红恰此一员，零意外红）✓');

    /* -------- 正证腿（细则①）：再生三件 → 全绿 + 纪元章断言 -------- */
    run(wt, process.execPath, [join('tools', 'extract-api-surface.mjs'), '--write'], '面抽取');
    const snap = JSON.parse(readFileSync(join(wt, 'src', 'contracts', 'api-surface.json'), 'utf8'));
    if (snap.enforcement !== 'ignited') {
      throw new Error(
        `[正证腿] 快照纪元章漂移：enforcement = ${String(snap.enforcement)}（期望 'ignited'——连锁面一断裂）`,
      );
    }
    console.log("[正证腿] 面抽取 --write → 快照纪元章 'ignited' ✓（连锁面一）");
    run(wt, process.execPath, [join('tools', 'generate-compatibility.mjs'), '--write'], '兼容档案生成');
    run(wt, process.execPath, [join('tools', 'generate-api-reference.mjs'), '--write'], 'API 参考生成');
    const compat = readFileSync(join(wt, 'COMPATIBILITY.md'), 'utf8');
    if (!compat.includes('执法纪元：`ignited`')) {
      throw new Error('[正证腿] COMPATIBILITY 纪元行未渲染 ignited——连锁面二断裂（生成器 eraOf 链漂移）');
    }
    console.log('[正证腿] 双生成物再生 → COMPATIBILITY 执法纪元行 ignited ✓（连锁面二）');
    run(wt, process.execPath, [join('tools', 'check-api.mjs')], 'check-api 全查');
    console.log('[正证腿] check-api 全查 → exit 0 全绿 ✓（细则①——先再生再查，对齐点火日动作清单）');

    /* -------- 连锁面五：PR 闸标签义务（演练树内临时 commit → --base 两跑） -------- */
    // 临时 commit 仅存在于 detached worktree（随 worktree remove 一并消亡，主区
    // 零接触）；点名四件 = 翻转的常量 + 再生三件——PR diff 面即点火日真实形态
    run(
      wt,
      'git',
      ['add', '--', 'src/contracts/api.ts', 'src/contracts/api-surface.json', 'COMPATIBILITY.md', 'docs/API参考.md'],
      '演练 commit',
    );
    run(
      wt,
      'git',
      ['commit', '--quiet', '--no-verify', '-m', 'rehearsal: simulated ignition (isolated worktree)'],
      '演练 commit',
    );
    const gateRed = spawnSync(process.execPath, [join('tools', 'check-api-pr-gate.mjs'), '--base', origSha], {
      cwd: wt,
      encoding: 'utf8',
      env: childEnv(),
    });
    if (gateRed.status !== 1 || !(gateRed.stderr + gateRed.stdout).includes('裁决标签')) {
      throw new Error(`[PR 闸] 无标签应红点名裁决标签义务（exit=${gateRed.status}）——连锁面五负腿断裂`);
    }
    console.log('[PR 闸] 无标签 → exit 1 点名裁决标签义务 ✓（连锁面五·负）');
    run(
      wt,
      process.execPath,
      [join('tools', 'check-api-pr-gate.mjs'), '--base', origSha, '--label', 'api-break: 演练点火'],
      'PR 闸带标签',
    );
    console.log('[PR 闸] api-break: 标签 → exit 0 ✓（连锁面五·正——点火 PR 语义 = 破坏性执法变更）');

    /* -------- 重腿（--core 跳过——vitest 回归锁形态） -------- */
    if (coreOnly) {
      console.log('[重腿] --core：typecheck + 面相关测试两重腿跳过（回归锁形态；点火日跑全量形态）');
    } else {
      run(wt, 'npm', ['run', 'typecheck'], 'typecheck');
      console.log('[重腿] typecheck → 全绿 ✓');
      // 面相关测试腿：点火日同笔测试清单 = 预期红（细则②枚举律延用于测试面——
      // 预期红 = 把现役 pre-ignition 行为写进断言的测试，点火日随常量同笔更新；
      // 意外红 = 此外一切 = 点火日会被打懵的隐藏态依赖，演练的价值面）
      const SAME_PEN_EXPECTED_REDS = [
        '出口 4：api 块缺席 → legacy', // 不传 ignited 的缺块腿——同笔改传显式 false 保分支覆盖
        '常量现役 = false', // 常量现役锁本体——同笔翻 toBe(true)
        '缺省参数跟常量单源', // 缺省参数行为锁——同笔改锁 ignited 默认形
      ];
      const leg = spawnSync(
        'npx',
        ['vitest', 'run', 'src/contracts/api.test.ts', 'tools/check-api.test.mjs', 'tools/check-api-pr-gate.test.mjs'],
        { cwd: wt, encoding: 'utf8', env: childEnv() },
      );
      const failed = parseFailedTitles(leg.stdout + leg.stderr);
      const unexpectedTests = failed.filter((t) => !SAME_PEN_EXPECTED_REDS.some((e) => t.includes(e)));
      const missingExpected = SAME_PEN_EXPECTED_REDS.filter((e) => !failed.some((t) => t.includes(e)));
      if (unexpectedTests.length > 0) {
        throw new Error(
          `[面相关测试] 意外红（预期红 = 同笔测试清单 ${JSON.stringify(SAME_PEN_EXPECTED_REDS)}）：\n  ${unexpectedTests.join('\n  ')}\n` +
            `——隐藏态依赖或同笔清单漂移：新红要么是须同笔更新的测试（进本清单），要么是点火日真事故`,
        );
      }
      if (missingExpected.length > 0) {
        throw new Error(
          `[面相关测试] 预期红缺席：${JSON.stringify(missingExpected)}——同笔测试被改形/改名，演练清单须随行（否则点火日漏更即 CI 红）`,
        );
      }
      console.log(
        `[重腿] 面相关测试 → 失败 ${failed.length} 项 = 同笔测试清单精确对账（预期红恰此三员，零意外红）✓（细则②枚举律；连锁面四两态注入单测在绿面）`,
      );
    }

    console.log('[演练] 五连锁面对账：快照纪元章 ✓ / 两生成物纪元渲染 ✓ / PR 闸标签义务 ✓；');
    console.log(
      '      连锁面三（api 块翻必填）= 点火日第二动作（清单 schema 翻必填，非常量翻转）——演练范围外（细则③），点火日动作清单第二笔；',
    );
    console.log(
      '      连锁面四（装载门 legacy 出口消失）= 单测两态注入覆盖（src/contracts/api.test.ts「收剑点火位」）——细则③。',
    );
    console.log(
      '[演练] 零意外红，演练通过——点火日按本链真做：翻常量 → 面抽取 --write → 双生成 --write → 提交（带 api-break: 标签）→ 清单 schema 翻必填同笔。',
    );
  } finally {
    // 收尾铁律：worktree 强拆（临时 commit 随之消亡）+ 残迹目录兜底清
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: REPO_ROOT, env: childEnv() });
    rmSync(wt, { recursive: true, force: true });
  }
}
