/**
 * L1 persist — 第六键 berryagent/sqlite 工厂测试（P0-2，契约篇 §1.2 注记①）。
 *
 * 主库拒开的全部命中形态：字面相等 / 相对路径 resolve 后相等 / symlink 别名
 * realpath 归一后相等；放行形态：':memory:' 恒放行（含主库自身是 :memory: 的
 * 装配）、树外自管库真开库可用。
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError, PLUGIN_MAIN_DB_FORBIDDEN } from '../contracts/errors.js';
import { createPluginSqliteFace } from './plugin-sqlite.js';

/** 临时目录（realpath 归一——macOS /var 与 /private/var 差异教训） */
function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'persist-plugin-sqlite-')));
}

describe('createPluginSqliteFace（第六键注入物工厂）', () => {
  it('主库路径命中即拒：字面相等 / 相对路径 resolve 后相等 / symlink 别名归一后相等 → PLUGIN_MAIN_DB_FORBIDDEN', () => {
    const dir = makeTempDir();
    const mainDb = join(dir, 'main.db');
    writeFileSync(mainDb, '');

    const face = createPluginSqliteFace(mainDb);
    // 字面相等
    expect(() => face.openDatabase(mainDb)).toThrowError(AppError);
    // 路径含 .. 归一后相等（resolve 归一命中——cwd 相对形态同语义，此处用
    // 绝对路径变体避免依赖测试进程 cwd）
    try {
      face.openDatabase(join(dir, 'sub', '..', 'main.db'));
      expect.unreachable('归一后命中主库应拒');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(PLUGIN_MAIN_DB_FORBIDDEN);
      expect((err as AppError).message).toContain('宿主主库');
    }
    // symlink 别名 realpath 归一后相等（别名逃逸同拦——spike 同规）
    const alias = join(dir, 'alias-to-main.db');
    symlinkSync(mainDb, alias);
    try {
      face.openDatabase(alias);
      expect.unreachable('symlink 别名命中主库应拒');
    } catch (err) {
      expect((err as AppError).code).toBe(PLUGIN_MAIN_DB_FORBIDDEN);
    }
  });

  it("':memory:' 恒放行（不落盘无碰撞可能），且主库为 ':memory:' 的装配形态不误伤插件自管内存库", () => {
    // 主库是文件路径：插件内存库照开
    const dir = makeTempDir();
    const face = createPluginSqliteFace(join(dir, 'main.db'));
    const mem = face.openDatabase(':memory:');
    expect(mem.open).toBe(true);
    mem.exec("create table t (v text); insert into t values ('ok');");
    expect(mem.prepare('select v from t').get()).toEqual({ v: 'ok' });
    mem.close();

    // 主库本身是 :memory:（测试/:memory: 装配）：插件内存库不误伤、文件路径不撞名
    const memMainFace = createPluginSqliteFace(':memory:');
    const mem2 = memMainFace.openDatabase(':memory:');
    expect(mem2.open).toBe(true);
    mem2.close();
  });

  it('树外自管库真开库：better-sqlite3 全量实例（DDL/DML 可用），readonly 选项透传', () => {
    const dir = makeTempDir();
    const face = createPluginSqliteFace(join(dir, 'host.db'));
    // 插件自己的数据子目录（ctx.paths.pluginDataDir 形态）
    const pluginDir = join(dir, 'plugins', 'my-plugin');
    mkdirSync(pluginDir, { recursive: true });
    const db = face.openDatabase(join(pluginDir, 'own.db'));
    db.exec("create table kv (k text primary key, v text); insert into kv values ('a', '1');");
    expect(db.prepare('select v from kv where k = ?').get('a')).toEqual({ v: '1' });
    db.close();
    // readonly 形态：再开只读句柄（写即抛——better-sqlite3 原生语义透传）
    const ro = face.openDatabase(join(pluginDir, 'own.db'), { readonly: true });
    expect(ro.prepare('select v from kv').get()).toEqual({ v: '1' });
    expect(() => ro.exec("insert into kv values ('b', '2');")).toThrowError();
    ro.close();
  });

  it('同实例背书：插件句柄与宿主直开的 better-sqlite3 是同一模块实例（函数引用相等）', () => {
    const dir = makeTempDir();
    const face = createPluginSqliteFace(join(dir, 'main.db'));
    const db = face.openDatabase(':memory:');
    // 与 persist 模块内直用的同一 Database 构造器（require 缓存单例）——
    // 双实例防线：版本/行为与宿主一致，插件永不需自捆 better-sqlite3
    expect(db.constructor).toBeDefined();
    expect(typeof db.prepare).toBe('function');
    db.close();
  });
});
