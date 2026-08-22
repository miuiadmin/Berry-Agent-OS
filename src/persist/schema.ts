/**
 * L1 persist — SQLite 物理层规范 schema（会话篇 §9 表族草案的固化）。
 *
 * 单库文件承载全部持久数据。6 张具体表 + 2 处占位（FTS5 / 记忆库表族）。
 * 唯一不可替代的表是 events——其余全部可丢弃可重建（检查点可重算、目录可再拉）。
 * STRICT + 复合主键 (session_id, seq) 强制唯一；seq 连续性由 appendCore 校验，
 * 永不被物理布局破坏（物理/逻辑分离原则：语义在 session 模块，编码在此）。
 */

/** schema 版本（PRAGMA user_version 门禁值；pre-release 不做迁移，不匹配即拒绝打开） */
export const SCHEMA_VERSION = 1;

/** 库身份魔数（PRAGMA application_id 门禁值；随意选定的 32 位正整数，作用=识别「这是本产品的库」） */
export const APPLICATION_ID = 0x62657272;

/**
 * 规范 DDL——按声明顺序执行。库内 schema 与此逐对象比对（normalize 后），
 * 任何漂移（缺表/多表/列定义变化）都拒绝打开（宁拒绝不误读）。
 */
export const CANONICAL_DDL = `
-- ── 1. 事件表：唯一事实源的物理形态 ──────────────────────────
CREATE TABLE events (
  session_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  type              TEXT NOT NULL,
  time              INTEGER NOT NULL,
  data              TEXT NOT NULL,
  source_event_seqs BLOB,
  surface_op        TEXT,
  ignorable         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, seq)
) STRICT;

-- ── 2. 会话元数据表：血缘 header 在此，不进事件流 ──────────────
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  schema_version    INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  cwd               TEXT,
  origin            TEXT NOT NULL,
  parent_session    TEXT,
  seed_length       INTEGER,
  delegation_depth  INTEGER NOT NULL DEFAULT 0,
  profile           TEXT,
  incarnation       TEXT NOT NULL,
  revision          INTEGER NOT NULL DEFAULT 0
) STRICT;

-- ── 3. 存储单例状态表 ───────────────────────────────────────
CREATE TABLE store_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  store_id       TEXT NOT NULL,
  schema_version INTEGER NOT NULL
) STRICT;

-- ── 4. 投影检查点表：读加速，丢了可全量重算 ───────────────────
-- M1 检查点纯内存（拍板 #5），表留 schema 不写
CREATE TABLE projection_checkpoints (
  session_id    TEXT NOT NULL,
  key           TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  seq           INTEGER NOT NULL,
  value         TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
) STRICT;

-- ── 5. 凭证表：明文 + 0600 文件权限 + 留加密 seam（拍板 #4）─────
-- modify 是唯一写路径且串行化（read-modify-write 防并发双刷新）
CREATE TABLE credentials (
  provider   TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- ── 6. 模型目录表：pi-ai ModelsStore + 用户覆盖 ───────────────
CREATE TABLE model_catalog (
  provider    TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  data        TEXT NOT NULL,
  source      TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, model_id)
) STRICT;

-- ── 7. 检索投影：FTS5 虚表（占位）────────────────────────────
-- 具体列与更新策略随检索需求定；由 persist 在事件落盘后异步维护
-- CREATE VIRTUAL TABLE session_fts USING fts5(...);

-- ── 8. 记忆库表族（占位，schema 归「记忆与自进化」篇）──────────
`;
