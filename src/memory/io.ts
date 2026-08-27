/**
 * L3 memory — 文件导入导出编排（记忆篇 §3 持有面第五件，第三十二批）。
 *
 * 用户命令面（/memory-export、/memory-import）的载荷件——**非模型工具**：
 * 运维动词不进工具面（可诱导外泄：模型不该有「把记忆库写文件」的动词；命令
 * 面零模型通路）。落盘判定 = 闭包注入可写根 + 本地 isInside（tools/fs.ts
 * 「不 cross-import 同款特判」先例——memory→safety 拓扑边不存在且不加）。
 *
 * 格式（§3 定稿）：JSONL——首行 header（format/formatVersion/exportedAt/
 * ownerScope/ownerRoots），其后每行一条主表现行值快照（17 列 snake_case 与库同构）。
 * - 导出全状态（含 dismissed/superseded/expired——迁移面要完整状态机）；
 * - 导入**恢复式幂等**：按 id 零合并——已存在 id 静默跳过（不产生新语义，只搬状态；
 *   内容面唯一写路径不破）；
 * - 导入逐行 secret 扫描（§8.1 同律——导入行不豁免写前扫描，命中行跳过计入报告）；
 * - v1 不含版本链与访问流水（文件最小面；历史与流水随库走）。
 *
 * **明文警示**：导出文件是明文 JSON——secret 扫描拦新增，历史已入座行（扫描
 * 规则演进前的漏网）随导出落盘。命令面输出警告文本，用户自担文件去向。
 */

import { join, sep } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { MemoryStore, MemoryExportRow } from './store.js';
import { detectSecret } from './scan.js';

/** 文件格式标识（header.format——导入侧校验；品牌词只出现在载荷字符串，非标识符） */
const EXPORT_FORMAT = 'berryagent-memory';

/** 文件格式版本（header.formatVersion——向后兼容判据；不匹配拒导） */
const EXPORT_FORMAT_VERSION = 1;

/** 导入报告（命令面输出与测试断言面） */
export interface ImportReport {
  /** 新导入行数 */
  readonly imported: number;
  /** 已存在跳过行数（恢复式幂等——id 命中即跳过） */
  readonly skippedExisting: number;
  /** secret 命中跳过行数（§8.1 同律——导入行不豁免写前扫描） */
  readonly skippedSecret: number;
  /** 解析/校验失败行数（含 header 不匹配的整体拒导） */
  readonly invalid: number;
  /** 整体拒导原因（header 校验失败时非空——此时行级计数全零） */
  readonly rejected?: 'format';
}

/** 导出 header 形态（首行；ownerRoots = 导出时生效的项目根列表——恢复侧环境核对用） */
export interface ExportHeader {
  readonly format: typeof EXPORT_FORMAT;
  readonly formatVersion: number;
  readonly exportedAt: number;
  /** 归属过滤（null = 全量导出） */
  readonly ownerScope: string | null;
  /** 导出时生效的项目归属根（人读核对面——导入不自动归账，按行内 owner_key 原样落） */
  readonly ownerRoots: readonly string[];
}

/**
 * 生成导出文本（JSONL）：header + 全状态行（id 升序——uuid v7 时间序）。
 * 纯编排件：取数走 store.exportRows，本件只负责 header 与序列化。
 * @param store 记忆库 DAO
 * @param ownerKey 归属过滤（缺省 = 全部归属——跨机器迁移面）
 * @param ownerRoots 导出时生效的项目根（header 人读面）
 */
export function exportMemoryText(store: MemoryStore, ownerKey?: string, ownerRoots: readonly string[] = []): string {
  const rows = store.exportRows(ownerKey);
  const header: ExportHeader = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: Date.now(),
    ownerScope: ownerKey ?? null,
    ownerRoots,
  };
  return [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n';
}

/**
 * 导出落盘（命令 handler 调用——路径合法性〔可写根 fence〕归 handler 判定，
 * 本件只写）。明文文件：调用方负责输出警示文本。
 */
export async function writeExportFile(filePath: string, text: string): Promise<void> {
  await writeFile(filePath, text, 'utf8');
}

/**
 * 导入文本解析与落库（恢复式幂等）：header 校验（format/formatVersion 不匹配
 * 整体拒导）→ 逐行 JSON 解析 → 结构校验（必需列在场）→ secret 扫描（summary/
 * content 双面，命中跳过计数）→ store.importRow 幂等直插。任一行失败不中断
 * 全批（尽力而为 + 计数报告——运维面要的是「导了多少、跳了多少、为何跳」）。
 */
export function importMemoryText(store: MemoryStore, text: string): ImportReport {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { imported: 0, skippedExisting: 0, skippedSecret: 0, invalid: 1, rejected: 'format' };
  // header 校验：首行必须是与导出面同源的 header，格式或版本不匹配整体拒导
  let header: ExportHeader;
  try {
    const parsed = JSON.parse(lines[0]!) as Partial<ExportHeader>;
    if (parsed.format !== EXPORT_FORMAT || parsed.formatVersion !== EXPORT_FORMAT_VERSION) {
      return { imported: 0, skippedExisting: 0, skippedSecret: 0, invalid: lines.length, rejected: 'format' };
    }
    header = parsed as ExportHeader;
  } catch {
    return { imported: 0, skippedExisting: 0, skippedSecret: 0, invalid: lines.length, rejected: 'format' };
  }
  void header; // header 的 ownerRoots 是人读面——导入按行内 owner_key 原样落，不自动归账
  const report = { imported: 0, skippedExisting: 0, skippedSecret: 0, invalid: 0 };
  for (const line of lines.slice(1)) {
    let row: MemoryExportRow;
    try {
      const parsed = JSON.parse(line) as Partial<MemoryExportRow>;
      // 结构校验：全 17 列在场（显式 null 合法——判 undefined 缺失；导出面
      // JSON.stringify 不会省略 null 列，缺失即手改/损坏文件）
      const required: Array<keyof MemoryExportRow> = [
        'id',
        'owner_key',
        'kind',
        'summary',
        'content',
        'confidence',
        'evidence_count',
        'usage_count',
        'last_used_at',
        'status',
        'superseded_by',
        'source_refs',
        'created_at',
        'updated_at',
        'frozen',
        'ttl_days',
        'expires_at',
      ];
      if (required.some((k) => parsed[k] === undefined)) throw new Error('missing column');
      row = parsed as MemoryExportRow;
    } catch {
      report.invalid += 1;
      continue;
    }
    // secret 扫描（§8.1 同律——导入行不豁免；双面扫，命中跳过计数不中断）
    if (detectSecret(row.summary) !== undefined || detectSecret(row.content) !== undefined) {
      report.skippedSecret += 1;
      continue;
    }
    if (store.importRow(row)) report.imported += 1;
    else report.skippedExisting += 1;
  }
  return report;
}

/** 导入读盘（命令 handler 调用——路径合法性归 handler 判定） */
export async function readImportFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

/**
 * 路径是否在任一可写根内（本地实现——tools/fs.ts isInside 同款特判先例：
 * memory→safety 拓扑边不存在且不加，防已有反向依赖成环）。根为文件系统根
 * sep 时任意绝对路径皆命中。
 * @param child 目标绝对路径
 * @param roots 可写根列表（闭包注入——装配层 rootsProvider 产物）
 */
export function isPathInsideRoots(child: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const prefix = root === sep ? sep : join(root, sep);
    return child === root || child.startsWith(prefix);
  });
}
