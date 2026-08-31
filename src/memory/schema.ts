/**
 * L3 memory — 记忆库表族 DDL（记忆与自进化篇 §3，user_version=2）。
 *
 * DDL 文本归 memory 模块自带、经 persist 统一迁移框架执行（会话篇 §6 落码形态）——
 * persist 提供框架不认识业务表。memories 主表 + memory_fts FTS5 外容投影（可丢弃可重建）
 * + 三触发器保持投影同步。
 */

import type { MigrationSpec } from '../persist/index.js';

/** 记忆表族迁移项（唯一事实源——指纹比对与建库都以本文本为准） */
export const MEMORY_MIGRATION: MigrationSpec = {
  version: 2,
  name: 'memory',
  sql: `
-- ── 记忆条目主表（记忆与自进化篇 §3）──────────────────────────
CREATE TABLE memories (
  id              TEXT PRIMARY KEY,      -- uuid v7（时间有序，排序免索引）
  owner_key       TEXT NOT NULL,         -- 归属范围：'global' | 'project:<根路径哈希>'
  kind            TEXT NOT NULL,         -- preference|fact|convention|correction|failure|insight|profile
  summary         TEXT NOT NULL,         -- 一句话摘要——合并与冲突判定的比较面（Mercury）
  content         TEXT NOT NULL,         -- 全文（注入用）
  confidence      REAL NOT NULL,         -- 0..1，合并取 max（保强证据不被均值稀释）
  evidence_count  INTEGER NOT NULL DEFAULT 1,  -- 独立证据次数
  status          TEXT NOT NULL DEFAULT 'active',  -- active|dismissed|superseded|expired（TTL 清扫物化置 expired）
  superseded_by   TEXT,                  -- 终态来源：'auto_resolved'|'user'|'llm:<id>'|'ttl'（TTL 清扫物化）|'skill:<技能名>'（晋升搬家——§9.1 第 3 项，第四十二批）
  source_refs     TEXT NOT NULL DEFAULT '[]',  -- JSON [{sessionId,seq}]——溯源到事件
  created_at      INTEGER NOT NULL,      -- Unix 毫秒
  updated_at      INTEGER NOT NULL       -- Unix 毫秒（老化判定的基准）
) STRICT;

CREATE INDEX idx_memories_owner_kind ON memories (owner_key, kind, status);

-- ── 全文检索投影（可丢弃可重建，外容表 + 触发器同步）────────────
-- tokenize=trigram：中英混排 substring 检索（unicode61 把连续中文段切成整 token，
-- 「包管理器」查不中「作为包管理器」）；权衡：查询 token <3 字符不命中（trigram 固有，
-- 2026-08-24 落码实证；<3 字符垃圾 token 在查询中被忽略——转义面天然安全）
CREATE VIRTUAL TABLE memory_fts USING fts5(summary, content, content=memories, content_rowid=rowid, tokenize='trigram');

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts (rowid, summary, content) VALUES (new.rowid, new.summary, new.content);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, summary, content) VALUES ('delete', old.rowid, old.summary, old.content);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, summary, content) VALUES ('delete', old.rowid, old.summary, old.content);
  INSERT INTO memory_fts (rowid, summary, content) VALUES (new.rowid, new.summary, new.content);
END;
`,
};

/**
 * 效用维度两列（记忆篇 §5 效用维度 + §6 引用回写，user_version=4——2026-08-24
 * 第十二批拍板题一；v4 槽位由本拍板预留、goal 表先行占 v5，故此迁移常驻链中
 * 排 GOAL_MIGRATION 之前）。存量行回填：usage_count=0（从未被引用）、
 * last_used_at=NULL（引用从未发生——简报排除判据以活动锚兜底，不误伤新条目）。
 */
export const MEMORY_UTILITY_MIGRATION: MigrationSpec = {
  version: 4,
  name: 'memory-utility',
  sql: `
-- ── 效用维度（「没被用的记忆自然死亡」——离开常驻面而非硬删）────────
ALTER TABLE memories ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0;  -- 被模型引用次数（引用回写计量面）
ALTER TABLE memories ADD COLUMN last_used_at INTEGER;  -- 最近被引用时间（Unix 毫秒；NULL=从未）
`,
};

/**
 * 持有面纵切（记忆篇 §3 持有面块，user_version=11——2026-08-27 第三十二批：
 * 条目级版本链 / TTL / Frozen / 访问日志五件，表族半边）。存量行回填
 * frozen=0、ttl_days=NULL、expires_at=NULL——**存量条目无 TTL，行为零变**
 * （读面谓词对 NULL 钟恒放行）；版本链与访问日志不回填历史（存量条目现行值
 * 即隐式基线，历史不可重建不伪造）。
 *
 * 语义分工（§3）：主表 = 现行值权威，memory_versions = append-only 内容面
 * 快照链（单事务双写），memory_access = 效用流水（聚合列 usage_count 的
 * 可查询审计面——聚合只随 cite，recall/search 只记流水）。
 */
export const MEMORY_HOLDING_MIGRATION: MigrationSpec = {
  version: 11,
  name: 'memory-holding',
  sql: `
-- ── 持有面三列（memories 表 ALTER）──────────────────────────
-- frozen：冻结位（恒简报/免 TTL/免合并覆写/免整理——§5/§6）；「冻结」= 豁免+恒驻义
ALTER TABLE memories ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0;
-- ttl_days：留存策略天数（NULL=永久缺省）；标记/续期以此重算。与 expires_at 双列
-- 非冗余：clock = 策略 + 续期时点，时点未另存故不可从策略单独推导
ALTER TABLE memories ADD COLUMN ttl_days INTEGER;
-- expires_at：过期钟（Unix 毫秒，NULL=不过期）；标记/续期时点写、清扫物化时清
--（判定源唯一交接给 status='expired'——软终态非删除，restore 可复活）
ALTER TABLE memories ADD COLUMN expires_at INTEGER;

-- ── 条目级版本链（append-only；主表现行值权威，内容面变更单事务双写）──────
CREATE TABLE memory_versions (
  id              TEXT PRIMARY KEY,      -- uuid v7
  memory_id       TEXT NOT NULL,         -- 归属条目
  revision        INTEGER NOT NULL,      -- 条目内递增（1 起 = 插入即落首版；与 sessions 表同概念同词）
  owner_key       TEXT NOT NULL,         -- 以下六列 = 快照内容面，与触发清单严格同集
  kind            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  content         TEXT NOT NULL,
  confidence      REAL NOT NULL,
  evidence_count  INTEGER NOT NULL,
  cause           TEXT NOT NULL,         -- 'insert'|'merge'|'decay'|'rollback'（闭集；机器判定词，与人读 reason 分词）
  created_at      INTEGER NOT NULL       -- 快照落账时间（Unix 毫秒）
) STRICT;

CREATE INDEX idx_versions_memory ON memory_versions (memory_id, revision);

-- ── 访问日志（聚合列 usage_count/last_used_at 的流水化审计面）──────────
CREATE TABLE memory_access (
  id          TEXT PRIMARY KEY,      -- uuid v7
  memory_id   TEXT NOT NULL,
  op          TEXT NOT NULL,         -- 'recall'（按需检索注入）| 'search'（工具检索命中）| 'cite'（引用回写）
  session_id  TEXT,                  -- 发生会话；search 行恒 NULL（ToolCtx 无会话键——扩面挂第二消费者）
  ts          INTEGER NOT NULL       -- Unix 毫秒
) STRICT;

CREATE INDEX idx_access_memory_ts ON memory_access (memory_id, ts);  -- 窗口清扫按 ts 全表扫可接受（90 天窗口量级）
`,
};
