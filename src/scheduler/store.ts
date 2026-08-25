/**
 * L3 scheduler — jobs 表 DAO（tick 第一刀）。
 *
 * 语义核心：**执行前抢占（reserve-then-run）**——`reserveRun` 用条件更新
 * 原子抢占触发权，`changes=1` 才允许 spawn 子进程（token 花费不可逆，
 * 抢占必须发生在花钱之前；执行后比对只知败不知省——2026-08-25 冷读 #1
 * 裁决）。SQLite UPDATE 单语句原子性保证双开两进程至多一个赢：败者
 * `changes=0` 让路不跑。
 *
 * 同一连接同步执行（better-sqlite3）：读-改窗口内若他进程已改行，
 * WHERE 比对自动失败——无需额外锁。
 */

import type { DatabaseConnection } from '../persist/index.js';
import type { JobRecord } from './types.js';

/** add 结果词汇：新增成功 / 同名拒（主键即身份，改错走 rm + add） */
export type AddJobOutcome = 'added' | 'duplicate';

/** reserveRun 结果词汇：抢占成功可跑 / 任务不存在 / 并发兄弟已抢占让路 */
export type ReserveOutcome = 'reserved' | 'missing' | 'lost-race';

/** 任务名词法（用户面词汇——禁空白/斜杠/前导连字符，防命令面解析歧义） */
export const JOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 行查询 SQL（列 AS 别名映射 camelCase——goal 表族同款） */
const SELECT_COLUMNS = `name, prompt, cwd, schedule, last_run_at AS lastRunAt,
                        created_at AS createdAt, updated_at AS updatedAt`;

/** jobs 表 DAO（连接注入——goal 件 GoalStore 同构） */
export class JobsStore {
  constructor(private readonly connection: DatabaseConnection) {}

  /** 新增任务（cwd/schedule 第一刀不设——字段为第二刀预留；同名拒） */
  add(name: string, prompt: string, now: number): AddJobOutcome {
    try {
      this.connection
        .prepare(
          `INSERT INTO jobs (name, prompt, cwd, schedule, last_run_at, created_at, updated_at)
           VALUES (?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(name, prompt, now, now);
      return 'added';
    } catch (err) {
      // UNIQUE 约束 = 同名拒（唯一预期异常；其余异常如实上抛）
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        return 'duplicate';
      }
      throw err;
    }
  }

  /** 全量任务清单（name 字典序——list 面稳定排序） */
  list(): JobRecord[] {
    return this.connection.prepare(`SELECT ${SELECT_COLUMNS} FROM jobs ORDER BY name`).all() as JobRecord[];
  }

  /** 单行查询（命令面回执与抢占前读） */
  get(name: string): JobRecord | undefined {
    return this.connection.prepare(`SELECT ${SELECT_COLUMNS} FROM jobs WHERE name = ?`).get(name) as
      JobRecord | undefined;
  }

  /** 删除任务（返回是否删到——rm 回执） */
  remove(name: string): boolean {
    return this.connection.prepare(`DELETE FROM jobs WHERE name = ?`).run(name).changes === 1;
  }

  /**
   * 执行前抢占：条件更新推进 last_run_at，赢家获得 spawn 权。
   * 读当前行值作比对键再原子更新（IS ?——绑定 null 即 IS NULL，null/值通吃）；
   * 两步间被他进程抢先时 WHERE 失败 changes=0 让路。
   */
  reserveRun(name: string, now: number): ReserveOutcome {
    const current = this.get(name);
    if (current === undefined) return 'missing';
    const changes = this.connection
      .prepare(`UPDATE jobs SET last_run_at = ?, updated_at = ? WHERE name = ? AND last_run_at IS ?`)
      .run(now, now, name, current.lastRunAt).changes;
    return changes === 1 ? 'reserved' : 'lost-race';
  }
}
