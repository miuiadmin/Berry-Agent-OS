/**
 * L1 persist — 统一迁移框架（会话篇 §6 落码形态，2026-08-24 M2 记忆应用纵切）。
 *
 * pre-release 期间 user_version 递进的唯一通道：迁移项 `{version, name, sql}` 数据化注册
 * ——DDL 文本归业务模块自带（首例 memory 表族 v2），persist 提供框架不认识业务表。
 * 开库时：全新库 = 基线 DDL + 迁移链一次到位；存量库按缺口顺序补跑（每迁移单事务
 * + user_version 前进）；schema 比对基线 = 基线 DDL ∪ 全部迁移产物累积指纹。
 * 「宁拒绝不误读」保留于降级方向：库内 user_version 高于宿主已知 = 拒绝打开。
 */

/**
 * 迁移项。注册时校验：version 必须大于基线 SCHEMA_VERSION、逐项严格递增、version/name/sql
 * 三字段齐备——违反即抛（装配期错误，不入库不改库）。
 */
export interface MigrationSpec {
  /** 目标 user_version（> 基线 SCHEMA_VERSION；决定补跑顺序） */
  readonly version: number;
  /** 迁移名（诊断清单用，如 'memory'——与业务模块对应） */
  readonly name: string;
  /** DDL/数据迁移文本（单事务执行；DDL 须含表/索引/触发器全部对象——比对指纹覆盖全部产物；纯数据迁移〔UPDATE/DELETE〕无 schema 产物、指纹零差合法——首例 v16 退役 id 归一） */
  readonly sql: string;
}

/**
 * 校验并排序迁移链（装配期调用一次）。
 * 规则：全部 version > 基线版本、严格递增无重复；DDL 非空。违反 = 装配错误即抛。
 * @param migrations 业务模块注册的迁移项（顺序无关，按 version 排序后返回）
 * @param baseVersion 基线 SCHEMA_VERSION（迁移链的起点，缺省 1）
 * @returns 按 version 升序的迁移链
 */
export function normalizeMigrations(migrations: readonly MigrationSpec[], baseVersion: number): MigrationSpec[] {
  const seen = new Set<number>();
  const out: MigrationSpec[] = [];
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= baseVersion) {
      throw new Error(`迁移项 ${m.name || '(未具名)'}：version=${m.version} 必须是大于基线 ${baseVersion} 的整数`);
    }
    if (!m.name || typeof m.name !== 'string') {
      throw new Error(`迁移项 version=${m.version}：name 缺失`);
    }
    if (typeof m.sql !== 'string' || m.sql.trim() === '') {
      throw new Error(`迁移项 ${m.name}（v${m.version}）：sql 为空`);
    }
    if (seen.has(m.version)) {
      throw new Error(`迁移项 version=${m.version} 重复（${m.name}）——每个版本至多一项迁移`);
    }
    seen.add(m.version);
    out.push(m);
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}
