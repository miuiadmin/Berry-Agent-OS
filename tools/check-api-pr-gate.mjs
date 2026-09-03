#!/usr/bin/env node
/**
 * API 治理 PR 裁决标签闸（契约篇 §6.13.6「面变更 PR 须带裁决标签」+ §6.13.8
 * CI 加强——2026-09-03 第九十一批窗口内机器建设）。
 *
 * 规则两刀：PR diff 触到 API 面真相文件而 PR 标签无一裁决标签
 * （api-break: / api-deprecate: / api-add: 前缀）即红——「自由不豁免记录」：
 * 面变更（增/删/改/重定级/废弃登记）必须由作者用标签宣告裁决级别，评审与
 * 档案（COMPATIBILITY.md 判级小节）据此对账；第二刀 = 快照在 diff 而两生成物
 * （COMPATIBILITY.md / docs/API参考.md）零 diff 即红——面变更必改至少一生成物
 * （渲染面全覆盖），零 diff = 漏再生。生成物的逐字节正确性由 check-api 查 8
 * 执法（本闸只看 diff 面，不渲染——秒级零依赖）。
 *
 * 面真相文件三件：
 * - src/contracts/api-surface.json——面快照（快照变 = 面变，查 1 守护对象）；
 * - src/contracts/deprecations.ts——DEP 注册簿（登记是治理动作 → api-deprecate:）；
 * - src/contracts/index.ts——公开桶根（直导出面变化的第一现场）。
 *
 * 输入两源：变更文件清单（BASE_SHA 给定时 `git diff --name-only BASE...HEAD`
 * ——三点形 = merge-base 语义即 PR 面；或 --files 直列）+ 标签（LABELS env
 * JSON 数组——CI toJSON 注入；或 --label 逐个）。纯核心 adjudicatePrApiGate
 * 导出供测试直锁；CLI 只是薄壳（与生成器两消费面同一函数同律）。
 *
 * 出口：绿静默过；红 stderr 指引 + exit 1。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** API 面真相文件（触其一 = 面变更 PR，须带裁决标签） */
const API_FACE_FILES = ['src/contracts/api-surface.json', 'src/contracts/deprecations.ts', 'src/contracts/index.ts'];

/** 生成物伴生对（§6.13.6「无 COMPATIBILITY 条目 → 红」的可赢形态：快照任一
 * 实质变更必改至少其一——渲染面全覆盖使然；两生成物由同一 build 尾挂再生） */
const ARTIFACT_FILES = ['COMPATIBILITY.md', 'docs/API参考.md'];

/** 裁决标签形（前缀式：api-break: <说明>——标签值本身携带裁决级别宣告） */
const VERDICT_LABEL_RE = /^(?:api-break|api-deprecate|api-add):/;

/**
 * 剥离 GIT_* 前缀环境（git 钩子泄漏面防线）：本闸若在 git 钩子环境内被调（CI 之外
 * 的本地方便门），宿主 git 导出的 GIT_DIR/GIT_INDEX_FILE 会让下方 `git diff` 读错
 * 仓——剥净后按 cwd 解析目标仓（与 check-api-pr-gate.test.mjs 的 cleanGitEnv 同律）。
 */
const cleanGitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/**
 * PR 裁决判定（纯函数——测试面直锁）。两道红条件：
 * ① 面文件触碰而无裁决标签（宣告缺席）；
 * ② 快照在 diff 而两生成物零 diff（漏再生——重跑 `npm run build` 即愈）。
 * @param {{ changedFiles: string[], labels: string[] }} input
 *   changedFiles = PR diff 文件清单（相对仓库根路径）；labels = PR 标签全集
 * @returns {{ ok: boolean, faceTouched: boolean, touched?: string[], verdictLabels?: string[], guidance?: string }}
 */
export function adjudicatePrApiGate({ changedFiles, labels }) {
  const touched = changedFiles.filter((f) => API_FACE_FILES.includes(f));
  if (touched.length === 0) return { ok: true, faceTouched: false };
  const verdictLabels = labels.filter((l) => VERDICT_LABEL_RE.test(l));
  if (verdictLabels.length === 0) {
    return {
      ok: false,
      faceTouched: true,
      touched,
      guidance:
        `本 PR 触到 API 面真相文件（${touched.join('、')}）而未带裁决标签——面变更必须宣告裁决级别：` +
        `api-add:（面增/升格，MINOR）/ api-deprecate:（废弃登记，进 DEP 注册簿）/ api-break:（破坏性，MAJOR）。` +
        `加标签后重新触发本闸（§6.13.6「自由不豁免记录」——评审与 COMPATIBILITY.md 判级据此对账）`,
    };
  }
  if (touched.includes('src/contracts/api-surface.json') && !changedFiles.some((f) => ARTIFACT_FILES.includes(f))) {
    return {
      ok: false,
      faceTouched: true,
      touched,
      verdictLabels,
      guidance:
        `面快照有 diff 而 ${ARTIFACT_FILES.join(' / ')} 零 diff——面变更必改至少一生成物（渲染面全覆盖），` +
        `疑似漏再生：重跑 \`npm run build\`（或 node tools/generate-*.mjs --write）后提交再生结果（§6.13.6/查 8 同律）`,
    };
  }
  return { ok: true, faceTouched: true, touched, verdictLabels };
}

/* ---------------- CLI 薄壳 ---------------- */

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const argv = process.argv.slice(2);
  /** --label 逐个收集（LABELS env JSON 数组优先——CI 注入形态） */
  const labels = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label' && argv[i + 1] !== undefined) labels.push(argv[++i]);
  }
  if (process.env.LABELS !== undefined) {
    // 容错出口（与真红 exit 1 不可区分即红失效——LABELS 是 CI 注入面，注入炸
    // 语法错不该伪装成闸红）：非法 JSON → 用法错 exit 2 + stderr 点名注入物
    try {
      labels.push(...JSON.parse(process.env.LABELS));
    } catch {
      console.error(`[PR 闸] LABELS env 非法 JSON（CI 注入面损坏）：${process.env.LABELS}`);
      process.exit(2);
    }
  }
  /** --files 逗号列（BASE_SHA 缺席时的本地方便门） */
  const filesIdx = argv.indexOf('--files');
  const baseIdx = argv.indexOf('--base');
  const baseSha = baseIdx >= 0 ? argv[baseIdx + 1] : process.env.BASE_SHA;
  let changedFiles;
  if (baseSha !== undefined) {
    // 三点形 diff = merge-base 语义（PR 面而非两条分支的全量差）；env 剥 GIT_* 防钩子泄漏错仓；
    // -c core.quotepath=false 防 CJK 路径八进制转义——转义形 "docs/API\345.." 与
    // ARTIFACT_FILES 裸中文串永不 matches，第二刀对已再生中文生成物的 PR 确定性假红
    const r = spawnSync('git', ['-c', 'core.quotepath=false', 'diff', '--name-only', `${baseSha}...HEAD`], {
      encoding: 'utf8',
      env: cleanGitEnv(),
    });
    if (r.status !== 0) throw new Error(`git diff ${baseSha}...HEAD 失败：${r.stderr}`);
    changedFiles = r.stdout.split('\n').filter((l) => l !== '');
  } else if (filesIdx >= 0 && argv[filesIdx + 1] !== undefined) {
    changedFiles = argv[filesIdx + 1].split(',').filter((f) => f !== '');
  } else {
    console.error(
      '用法：check-api-pr-gate.mjs [--base <sha> | --files <a,b,c>] [--label <l>]…（或 env BASE_SHA / LABELS）',
    );
    process.exit(2);
  }
  const verdict = adjudicatePrApiGate({ changedFiles, labels });
  if (!verdict.ok) {
    console.error(`[PR 闸] ${verdict.guidance}`);
    process.exit(1);
  }
  if (verdict.faceTouched) {
    console.log(`[PR 闸] 面变更已宣告：${verdict.verdictLabels.join('、')}`);
  }
}
