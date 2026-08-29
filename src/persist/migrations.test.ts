/**
 * L1 persist 单元测试（统一迁移框架半边）——链校验 / 全新库一次到位 / 内核迁移
 * 自注入 / 存量补跑 / 降级拒绝 / 指纹含触发器。hermetic：临时目录建库，用后即清。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from './index.js';
import { normalizeMigrations, type MigrationSpec } from './migrations.js';
import {
  SESSION_APP_COLUMN_MIGRATION,
  SESSION_IMPORTER_COLUMN_MIGRATION,
  DROP_PROJECTION_CHECKPOINTS_MIGRATION,
} from './schema.js';

/** 临时库目录（全文件共享，结束后整体清除） */
let dir: string;
/** 测试用库文件路径（每用例独立文件名防互扰） */
let seq = 0;
const nextPath = (): string => join(dir, `t-${seq++}.db`);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'persist-mig-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 最小可用迁移项素材（不动业务表——框架测试只关心框架行为；表名随版本变防链内冲突）。
 * 版本一律取内核链尾之上（内核恒自注入 v6〔sessions +app〕、v10〔sessions
 * +importer〕与 v12〔DROP projection_checkpoints〕——见下方内核迁移组用例），
 * 业务缺口模拟才可能与内核共存于同一条链。
 */
const spec = (version: number, name = `m${version}`): MigrationSpec => ({
  version,
  name,
  sql: `CREATE TABLE mig_${'x'.repeat(version - 1)} (a INTEGER) STRICT;`,
});

/** 内核链首版本（sessions +app 列，v6） */
const KERNEL_FIRST = SESSION_APP_COLUMN_MIGRATION.version;
/** 内核链尾版本（DROP projection_checkpoints，v12——业务链版本的起算锚点） */
const KERNEL_TAIL = DROP_PROJECTION_CHECKPOINTS_MIGRATION.version;

describe('normalizeMigrations 链校验（装配期即抛，不动库）', () => {
  it('version 必须大于基线且为整数', () => {
    expect(() => normalizeMigrations([spec(1)], 1)).toThrowError(/大于基线/);
    expect(() => normalizeMigrations([spec(1.5)], 1)).toThrowError(/整数/);
  });
  it('name 与 sql 缺失即抛', () => {
    expect(() => normalizeMigrations([{ version: 2, name: '', sql: 'CREATE TABLE a (b) STRICT;' }], 1)).toThrowError(
      /name 缺失/,
    );
    expect(() => normalizeMigrations([{ version: 2, name: 'x', sql: '  ' }], 1)).toThrowError(/sql 为空/);
  });
  it('version 重复即抛', () => {
    expect(() => normalizeMigrations([spec(2, 'a'), spec(2, 'b')], 1)).toThrowError(/重复/);
  });
  it('顺序无关：按 version 升序返回', () => {
    const chain = normalizeMigrations([spec(3), spec(2)], 1);
    expect(chain.map((m) => m.version)).toEqual([2, 3]);
  });
  it('空链合法（纯基线库形态）', () => {
    expect(normalizeMigrations([], 1)).toEqual([]);
  });
});

describe('全新库：基线 + 迁移链一次到位', () => {
  it('user_version 直达链尾，迁移对象全部建立', () => {
    const path = nextPath();
    const store = openStore({ path, migrations: [spec(KERNEL_TAIL + 1)] });
    store.close();
    const raw = new Database(path);
    const uv = raw.pragma('user_version', { simple: true });
    const hasMig = raw
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'mig_${'x'.repeat(KERNEL_TAIL)}'`)
      .get() as { n: number };
    raw.close();
    expect(uv).toBe(KERNEL_TAIL + 1);
    expect(hasMig.n).toBe(1);
  });

  it('多级链一次到位（链尾-1 → 链尾两连跳）', () => {
    const path = nextPath();
    openStore({ path, migrations: [spec(KERNEL_TAIL + 1), spec(KERNEL_TAIL + 2)] }).close();
    const raw = new Database(path);
    expect(raw.pragma('user_version', { simple: true })).toBe(KERNEL_TAIL + 2);
    raw.close();
  });
});

describe('内核迁移自注入（sessions 是内核表——DDL 演进不归业务调用方感知）', () => {
  it('空链开库也达内核链尾：uv = 内核链尾，sessions 带 app + importer 列', () => {
    const path = nextPath();
    openStore({ path }).close();
    const raw = new Database(path);
    expect(raw.pragma('user_version', { simple: true })).toBe(KERNEL_TAIL);
    const cols = (raw.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name);
    raw.close();
    expect(cols).toContain('app');
    expect(cols).toContain('importer');
  });

  it('业务迁移撞内核版本号 = 装配期拒绝（版本空间共享，严格递增执法）', () => {
    const path = nextPath();
    expect(() =>
      openStore({
        path,
        migrations: [{ version: KERNEL_FIRST, name: 'claim-kernel-slot', sql: 'CREATE TABLE k (a INTEGER) STRICT;' }],
      }),
    ).toThrowError(/重复/);
    // 链尾同律：撞 v12（drop-projection-checkpoints）同样拒绝——版本空间共享对整条内核链生效
    expect(() =>
      openStore({
        path,
        migrations: [{ version: KERNEL_TAIL, name: 'claim-kernel-tail', sql: 'CREATE TABLE k2 (a INTEGER) STRICT;' }],
      }),
    ).toThrowError(/重复/);
  });

  it('旧形态库（无 app/importer 列、旧版本号）重开 = 内核缺口补跑到位', () => {
    const path = nextPath();
    openStore({ path }).close();
    // 原生退回旧形态：撤内核列 + 回拨 user_version（模拟内核迁移落地前的库）
    const rewind = new Database(path);
    rewind.exec('ALTER TABLE sessions DROP COLUMN importer');
    rewind.exec('ALTER TABLE sessions DROP COLUMN app');
    rewind.pragma('user_version = 1');
    rewind.close();
    const reopened = openStore({ path });
    reopened.close();
    const raw = new Database(path);
    expect(raw.pragma('user_version', { simple: true })).toBe(KERNEL_TAIL);
    const cols = (raw.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name);
    raw.close();
    expect(cols).toContain('app');
    expect(cols).toContain('importer');
  });
});

describe('v12 内核迁移：DROP projection_checkpoints（挂账⑤销账，会话篇 §5.3 checkpoint 纵切）', () => {
  it('新库基线无此表（CANONICAL_DDL 已摘除；v12 前滚 no-op 不炸）', () => {
    const path = nextPath();
    expect(() => openStore({ path }).close()).not.toThrow();
    const raw = new Database(path);
    const has = raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'projection_checkpoints'`).get() as {
      n: number;
    };
    raw.close();
    expect(has.n).toBe(0);
  });

  it('旧形态库（基线含此表、uv=1）重开 = 表被 DROP、基线数据完好', () => {
    const path = nextPath();
    // 起一个基线库并写一条数据（迁移不碰业务数据的锚点复用）
    const base = openStore({ path });
    base.appendCore(
      { sessionId: 'sess-v12', origin: 'user', seedLength: 0, delegationDepth: 0 },
      [{ type: 'user/message', seq: 0, time: 1755900000000, data: { content: 'v12 销账' } }],
      'inc-1',
    );
    base.close();
    // 原生造旧形态：撤内核列 + 手建旧基线表 + uv 回拨 1（模拟 v12 落地前的库）
    const rewind = new Database(path);
    rewind.exec('ALTER TABLE sessions DROP COLUMN importer');
    rewind.exec('ALTER TABLE sessions DROP COLUMN app');
    rewind.exec(`CREATE TABLE projection_checkpoints (
      session_id TEXT NOT NULL, key TEXT NOT NULL, state_version INTEGER NOT NULL,
      seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (session_id, key)) STRICT;`);
    rewind.pragma('user_version = 1');
    rewind.close();
    // 重开：v6/v10 补列 + v12 真删表
    const reopened = openStore({ path });
    reopened.close();
    const raw = new Database(path);
    const has = raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'projection_checkpoints'`).get() as {
      n: number;
    };
    const events = raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    raw.close();
    expect(has.n).toBe(0); // 旧表已清
    expect(events.n).toBe(1); // 基线数据完好
  });
});

describe('存量库：按缺口补跑（只前进）', () => {
  it('内核基线库带链重开 → 补跑业务缺口，基线数据完好', () => {
    const path = nextPath();
    // 先以空链开一个基线库（内核链尾）并写一条基线数据
    const base = openStore({ path });
    base.appendCore(
      { sessionId: 'sess-mig', origin: 'user', seedLength: 0, delegationDepth: 0 },
      [{ type: 'user/message', seq: 0, time: 1755900000000, data: { content: '基线数据' } }],
      'inc-1',
    );
    base.close();
    // 带链重开：补跑业务迁移（内核已在位，只补其上缺口）
    const grown = openStore({ path, migrations: [spec(KERNEL_TAIL + 1)] });
    grown.close();
    const raw = new Database(path);
    expect(raw.pragma('user_version', { simple: true })).toBe(KERNEL_TAIL + 1);
    const events = raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    const mig = raw.prepare(`SELECT COUNT(*) AS n FROM mig_${'x'.repeat(KERNEL_TAIL)}`).get() as { n: number };
    raw.close();
    expect(events.n).toBe(1); // 迁移不碰基线数据
    expect(mig.n).toBe(0);
  });

  it('链尾版本已到 = 不重跑（幂等重开）', () => {
    const path = nextPath();
    openStore({ path, migrations: [spec(KERNEL_TAIL + 1)] }).close();
    // 再开一次同链：无补跑、无报错
    expect(() => openStore({ path, migrations: [spec(KERNEL_TAIL + 1)] })).not.toThrow();
  });
});

describe('降级方向：宁拒绝不误读', () => {
  it('库内版本高于宿主链尾 = 拒绝打开', () => {
    const path = nextPath();
    openStore({ path, migrations: [spec(KERNEL_TAIL + 1)] }).close();
    // 宿主不带业务链（只知内核链尾）去开更高版本的库
    expect(() => openStore({ path })).toThrowError(/降级不支持/);
  });
});

describe('累积指纹：迁移产物全覆盖（含触发器）', () => {
  it('迁移产物被篡改（DROP 触发器）= 拒绝打开', () => {
    const path = nextPath();
    const triggerSql = `
      CREATE TABLE trig_base (a INTEGER) STRICT;
      CREATE TRIGGER trig_guard AFTER INSERT ON trig_base BEGIN
        SELECT 1;
      END;`;
    openStore({ path, migrations: [{ version: 2, name: 'trig', sql: triggerSql }] }).close();
    // 直接用 better-sqlite3 抹掉触发器（模拟产物漂移）
    const raw = new Database(path);
    raw.exec('DROP TRIGGER trig_guard');
    raw.close();
    expect(() => openStore({ path, migrations: [{ version: 2, name: 'trig', sql: triggerSql }] })).toThrowError(
      /schema 与规范不一致/,
    );
  });

  it('迁移链内容变更（同版本换 DDL）= 指纹拒绝', () => {
    const path = nextPath();
    openStore({
      path,
      migrations: [{ version: 2, name: 'm', sql: 'CREATE TABLE mig_v2 (a INTEGER) STRICT;' }],
    }).close();
    // 同版本但 DDL 加了列——库内产物与链产物不一致
    expect(() =>
      openStore({
        path,
        migrations: [{ version: 2, name: 'm', sql: 'CREATE TABLE mig_v2 (a INTEGER, b TEXT) STRICT;' }],
      }),
    ).toThrowError(/schema 与规范不一致/);
  });
});
