/**
 * L1 persist 单元测试（统一迁移框架半边）——链校验 / 全新库一次到位 / 存量补跑 /
 * 降级拒绝 / 指纹含触发器。hermetic：临时目录建库，用后即清。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from './index.js';
import { normalizeMigrations, type MigrationSpec } from './migrations.js';

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

/** 最小可用迁移项素材（不动业务表——框架测试只关心框架行为；表名随版本变防链内冲突） */
const spec = (version: number, name = `m${version}`): MigrationSpec => ({
  version,
  name,
  sql: `CREATE TABLE mig_${'x'.repeat(version - 1)} (a INTEGER) STRICT;`,
});

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
    const store = openStore({ path, migrations: [spec(2)] });
    store.close();
    const raw = new Database(path);
    const uv = raw.pragma('user_version', { simple: true });
    const hasMig = raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'mig_x'").get() as { n: number };
    raw.close();
    expect(uv).toBe(2);
    expect(hasMig.n).toBe(1);
  });

  it('多级链一次到位（2 → 3）', () => {
    const path = nextPath();
    openStore({ path, migrations: [spec(2), spec(3)] }).close();
    const raw = new Database(path);
    expect(raw.pragma('user_version', { simple: true })).toBe(3);
    raw.close();
  });
});

describe('存量库：按缺口补跑（只前进）', () => {
  it('v1 库带链重开 → 补跑至 v2，基线数据完好', () => {
    const path = nextPath();
    // 先以空链开一个 v1 库并写一条基线数据
    const v1 = openStore({ path });
    v1.appendCore(
      { sessionId: 'sess-mig', origin: 'user', seedLength: 0, delegationDepth: 0 },
      [{ type: 'user/message', seq: 0, time: 1755900000000, data: { content: '基线数据' } }],
      'inc-1',
    );
    v1.close();
    // 带链重开：补跑迁移
    const v2 = openStore({ path, migrations: [spec(2)] });
    v2.close();
    const raw = new Database(path);
    expect(raw.pragma('user_version', { simple: true })).toBe(2);
    const events = raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    const mig = raw.prepare('SELECT COUNT(*) AS n FROM mig_x').get() as { n: number };
    raw.close();
    expect(events.n).toBe(1); // 迁移不碰基线数据
    expect(mig.n).toBe(0);
  });

  it('链尾版本已到 = 不重跑（幂等重开）', () => {
    const path = nextPath();
    openStore({ path, migrations: [spec(2)] }).close();
    // 再开一次同链：无补跑、无报错
    expect(() => openStore({ path, migrations: [spec(2)] })).not.toThrow();
  });
});

describe('降级方向：宁拒绝不误读', () => {
  it('库内版本高于宿主链尾 = 拒绝打开', () => {
    const path = nextPath();
    openStore({ path, migrations: [spec(2)] }).close();
    // 宿主不带链（只知 v1）去开 v2 库
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
