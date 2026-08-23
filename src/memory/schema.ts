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
  status          TEXT NOT NULL DEFAULT 'active',  -- active|dismissed|superseded
  superseded_by   TEXT,                  -- 终态来源：'auto_resolved'|'user'|'llm:<id>'
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
