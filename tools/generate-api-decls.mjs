#!/usr/bin/env node
/**
 * api-decls Face 派生两 .d.ts 生成器（契约篇 §6.13.9「手稳件升生成物」——
 * 2026-09-04 进化批刀 D，「手稳件」概念消亡）。
 *
 * 生成对象 = `api-decls/berryagent-llm.d.ts` + `api-decls/berryagent-sqlite.d.ts`
 * 全文：declare 行键集从【提交位面快照】的对应模块域派生（快照的 llm/sqlite 域
 * 又源自 providerApiFace / createAppSqliteFace() 运行时键集——jiti 单源，与
 * loader 注入物同物）。修前这两件靠人肉记忆与 Face 对齐：Face 加键后 drift 红
 * 只指引快照与两 md，手稳件加行零闸（第三方作者类型面缺键、编译期才撞）。
 *
 * 三消费面同一渲染函数（生成器纪律——drift 判定与人工再生天然同源）：
 * - check-api 查 8（生成物 drift）：committed 两文件 ≠ renderFaceDecls(快照)
 *   即红——键集漂移结构性不可达；
 * - CLI `--write`：再生成落盘（Face 变更工作流 = 抽取器 --write → 本件 --write）；
 * - tools/emit-api-decls.mjs（构建子步）：declareKeysOf 复用做 dist 拷贝后的
 *   键集双向对账（Face 运行时键 ⇄ 拷贝件 declare 键——锚定核验升格，§6.13.9）。
 *
 * env 缝：CHECK_API_SNAPSHOT 与 check-api 同名同语义（回归锁换片位，不动真身）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（脚本位置上一级） */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 生成物目录（随包分发件——committed，查 8 守护对象） */
export const API_DECLS_DIR = join(REPO_ROOT, 'api-decls');

/**
 * 两 Face 派生文件的生成规格（头注为公开产物面文案——零知识域指路）。
 * alias = 类型别名行（llm 的 typeof 派生形；sqlite 直引接口无需别名）；
 * typeRef = declare 行索引访问的前缀类型名。
 */
export const FACE_DECL_SPECS = [
  {
    fileName: 'berryagent-llm.d.ts',
    module: 'berryagent/llm',
    importName: 'providerApiFace',
    importSpec: '../llm/provider-face.js',
    alias: 'type Face = typeof providerApiFace;',
    typeRef: 'Face',
    header: [
      '虚拟模块 `berryagent/llm` 的类型面（第五虚拟键——pi-ai provider 工厂族）。',
      '',
      '运行时注入物 = llm 模块 providerApiFace 对象（键即导出面）；类型面以 indexed',
      'access 从同一对象派生——单源不重抄签名。宿主类型锚 = dist/llm/provider-face.d.ts',
      '（tsconfig.api.json 发射；其 pi-ai 类型引用经宿主依赖链解析）。',
    ],
  },
  {
    fileName: 'berryagent-sqlite.d.ts',
    module: 'berryagent/sqlite',
    importName: 'AppSqliteFace',
    importSpec: '../persist/app-sqlite.js',
    alias: null,
    typeRef: 'AppSqliteFace',
    header: [
      '虚拟模块 `berryagent/sqlite` 的类型面（第六虚拟键——宿主同实例 better-sqlite3）。',
      '运行时注入物 = persist 模块 createAppSqliteFace() 产物（主库拒开包装）；',
      '类型面以 indexed access 从 AppSqliteFace 派生——单源不重抄签名。',
    ],
  },
];

/**
 * 从面快照渲染两 Face 派生 .d.ts 全文（纯函数——查 8 与 CLI 同源）。
 * @param {{ exports: Array<{ module: string, symbol: string }> }} surface 面快照（提交位）
 * @returns {Map<string, string>} 文件名 → 全文（生成物定格形态：恰一尾换行）
 */
export function renderFaceDecls(surface) {
  const out = new Map();
  for (const spec of FACE_DECL_SPECS) {
    // 键集 = 快照对应模块域符号（快照恒按 module/symbol 双键排序——declare 行
    // 即字典序，重生成序稳定）
    const keys = surface.exports.filter((e) => e.module === spec.module).map((e) => e.symbol);
    if (keys.length === 0) {
      throw new Error(`renderFaceDecls：快照 ${spec.module} 域零导出（快照漂移或模块名漂移——先跑抽取器 --write）`);
    }
    const lines = [];
    lines.push('/**');
    // 空串 = 注释空行（裸 ` *` 无尾随空格）
    for (const h of spec.header) lines.push(h === '' ? ' *' : ` * ${h}`);
    lines.push(' *');
    lines.push(' * 本文件由 tools/generate-api-decls.mjs 生成（declare 行从面快照 Face 键集派生）——勿手编。');
    lines.push(' */');
    lines.push(`import type { ${spec.importName} } from '${spec.importSpec}';`);
    lines.push('');
    if (spec.alias !== null) {
      lines.push(spec.alias);
      lines.push('');
    }
    for (const k of keys) lines.push(`export declare const ${k}: ${spec.typeRef}['${k}'];`);
    out.set(spec.fileName, lines.join('\n') + '\n');
  }
  return out;
}

/**
 * .d.ts 文本的 declare 行键集提取（emit-api-decls 键集双向对账共用——两消费面
 * 同一识别形 `export declare const 名:` 逐行）。
 * @param {string} dtsText .d.ts 全文
 * @returns {string[]} declare 键（出现序）
 */
export function declareKeysOf(dtsText) {
  return [...dtsText.matchAll(/^export declare const (\w+):/gm)].map((m) => m[1]);
}

/* ---------------- CLI 薄壳（--write 落盘；缺省逐件打印键数摘要） ---------------- */

// CLI 直跑判定（健壮形——与 generate-compatibility.mjs 同款）：resolve 对照
// argv[1] 绝对化后与自身 fileURLToPath 逐字节比（URL 手拼对照在路径含 #/? 等
// 保留字符时必错）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshotPath =
    process.env.CHECK_API_SNAPSHOT !== undefined
      ? resolve(REPO_ROOT, process.env.CHECK_API_SNAPSHOT)
      : join(REPO_ROOT, 'src/contracts/api-surface.json');
  const surface = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  for (const [fileName, text] of renderFaceDecls(surface)) {
    const path = join(API_DECLS_DIR, fileName);
    if (process.argv.includes('--write')) {
      writeFileSync(path, text);
      console.log(`api-decls/${fileName} 已再生（declare ${declareKeysOf(text).length} 键——查 8 守护对象）`);
    } else {
      console.log(`api-decls/${fileName}：declare ${declareKeysOf(text).length} 键（--write 落盘）`);
    }
  }
}
