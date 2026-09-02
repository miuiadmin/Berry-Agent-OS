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
import type { JobRecord, RunReason } from './types.js';

/** add 结果词汇：新增成功 / 同名拒（主键即身份，改错走 rm + add） */
export type AddJobOutcome = 'added' | 'duplicate';

/** reserveRun 结果词汇：抢占成功可跑 / 任务不存在 / 并发兄弟已抢占让路 */
export type ReserveOutcome = 'reserved' | 'missing' | 'lost-race';

/** 任务名词法（用户面词汇——禁空白/斜杠/前导连字符，防命令面解析歧义） */
export const JOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 行查询 SQL（列 AS 别名映射 camelCase——goal 表族同款；v9/v14 列随行读出） */
const SELECT_COLUMNS = `name, prompt, cwd, schedule, last_run_at AS lastRunAt,
                        created_at AS createdAt, updated_at AS updatedAt,
                        last_run_reason AS lastRunReason, session_id AS sessionId,
                        last_session_id AS lastSessionId, owner, owner_key AS ownerKey,
                        enabled`;

/**
 * 原始行 → JobRecord（enabled 0/1 整数 → boolean——SQLite 无布耳型，读出统一
 * 在此收口；其余列经 SQL AS 别名已对齐 camelCase）。
 */
function mapRow(row: unknown): JobRecord {
  return { ...(row as Omit<JobRecord, 'enabled'>), enabled: (row as { enabled: number }).enabled !== 0 };
}

/** jobs 表 DAO（连接注入——goal 件 GoalStore 同构） */
export class JobsStore {
  constructor(private readonly connection: DatabaseConnection) {}

  /**
   * 新增任务（同名拒）。schedule 为可选触发声明**原样串**（调用方已过
   * parseSchedule 执法——本层不重复解析，存原样保人读；null = 仅手动触发）。
   */
  add(name: string, prompt: string, now: number, schedule: string | null = null): AddJobOutcome {
    try {
      this.connection
        .prepare(
          `INSERT INTO jobs (name, prompt, cwd, schedule, last_run_at, created_at, updated_at,
                             last_run_reason, session_id, last_session_id)
           VALUES (?, ?, NULL, ?, NULL, ?, ?, NULL, NULL, NULL)`,
        )
        .run(name, prompt, schedule, now, now);
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
    return this.connection.prepare(`SELECT ${SELECT_COLUMNS} FROM jobs ORDER BY name`).all().map(mapRow);
  }

  /** 单行查询（命令面回执与抢占前读） */
  get(name: string): JobRecord | undefined {
    const row = this.connection.prepare(`SELECT ${SELECT_COLUMNS} FROM jobs WHERE name = ?`).get(name);
    return row === undefined ? undefined : mapRow(row);
  }

  /* ---- v14 归属族（goal 挂钟承载——owner/owner_key/enabled 三列的写读面） ---- */

  /**
   * 归属行查询（(owner, owner_key) 联合寻径——goal 挂钟行的唯一寻径；miss =
   * 该归属无任务行）。同 owner 多行（历史遗留）取 updated_at 最新——归属
   * 唯一性由 putOwned 的确定性名约定保证，此兜底仅防御手编库。
   */
  getOwned(owner: string, ownerKey: string): JobRecord | undefined {
    const row = this.connection
      .prepare(`SELECT ${SELECT_COLUMNS} FROM jobs WHERE owner = ? AND owner_key = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(owner, ownerKey);
    return row === undefined ? undefined : mapRow(row);
  }

  /**
   * 归属行 upsert（重挂 = 同名覆盖）：新行 INSERT；同名已存 UPDATE 覆盖
   * prompt/schedule/session_id/owner/owner_key 并复活 enabled=1——
   * last_run_at（抢占比对键）与 created_at 保留（every/daily 重挂不是重置触发史
   * ——防补拍双跑；once 形重挂在调用侧先 removeOwned 清史再插，见 app.ts
   * goalFace.register——定向复扫 20260902 第七轮 M-3）。
   * 名确定性由调用方约定（face 侧 goal-<goalId>），同名即同行。
   */
  putOwned(job: {
    readonly name: string;
    readonly prompt: string;
    readonly schedule: string;
    readonly sessionId: string;
    readonly owner: string;
    readonly ownerKey: string;
    readonly now: number;
  }): void {
    this.connection
      .prepare(
        `INSERT INTO jobs (name, prompt, cwd, schedule, last_run_at, created_at, updated_at,
                           last_run_reason, session_id, last_session_id, owner, owner_key, enabled)
         VALUES (?, ?, NULL, ?, NULL, ?, ?, NULL, ?, NULL, ?, ?, 1)
         ON CONFLICT(name) DO UPDATE SET
           prompt = excluded.prompt, schedule = excluded.schedule,
           session_id = excluded.session_id, owner = excluded.owner,
           owner_key = excluded.owner_key, enabled = 1, updated_at = excluded.updated_at`,
      )
      .run(job.name, job.prompt, job.schedule, job.now, job.now, job.sessionId, job.owner, job.ownerKey);
  }

  /**
   * 生命周期位翻转（终态/降级置 0 · resume/重挂置 1）：行留史 + OS 注册
   * 保留——tick 编排预读发现让路（免整机装配的廉价 no-op）。0 行命中 =
   * 无挂钟行（未挂过钟的 goal），静默 no-op 非错误。
   */
  setOwnedEnabled(owner: string, ownerKey: string, enabled: boolean, now: number): void {
    this.connection
      .prepare(`UPDATE jobs SET enabled = ?, updated_at = ? WHERE owner = ? AND owner_key = ?`)
      .run(enabled ? 1 : 0, now, owner, ownerKey);
  }

  /**
   * 归属行删除（/goal wake off 联动——防幽灵行）：返回被删行名（OS 注销
   * 需要；未删到 = null，调用方跳过注销）。
   */
  removeOwned(owner: string, ownerKey: string): string | null {
    const row = this.getOwned(owner, ownerKey);
    if (row === undefined) return null;
    this.connection.prepare(`DELETE FROM jobs WHERE name = ?`).run(row.name);
    return row.name;
  }

  /** 删除任务（返回是否删到——rm 回执） */
  remove(name: string): boolean {
    return this.connection.prepare(`DELETE FROM jobs WHERE name = ?`).run(name).changes === 1;
  }

  /**
   * 执行前抢占：条件更新推进 last_run_at，赢家获得 spawn 权。
   * 读当前行值作比对键再原子更新（IS ?——绑定 null 即 IS NULL，null/值通吃）；
   * 两步间被他进程抢先时 WHERE 失败 changes=0 让路。
   * @param reason 触发记因（v9 列——'manual' 手动 / 'scheduled' 到点）
   */
  reserveRun(name: string, now: number, reason: RunReason): ReserveOutcome {
    const current = this.get(name);
    if (current === undefined) return 'missing';
    const changes = this.connection
      .prepare(
        `UPDATE jobs SET last_run_at = ?, last_run_reason = ?, updated_at = ?
         WHERE name = ? AND last_run_at IS ?`,
      )
      .run(now, reason, now, name, current.lastRunAt).changes;
    return changes === 1 ? 'reserved' : 'lost-race';
  }

  /**
   * once 迟到记因（due 判定 missed 路写——**不推进 last_run_at**：没触发就
   * 不该动触发时刻，只把「为何没跑」记进 last_run_reason 供 list/诊断可见）。
   */
  markMissed(name: string, now: number): void {
    this.connection.prepare(`UPDATE jobs SET last_run_reason = 'missed', updated_at = ? WHERE name = ?`).run(now, name);
  }

  /**
   * 回写最近会话归属（v9 列 last_session_id——K2-c 编排层在子进程会话建行后
   * 回写；任务↔会话精确归属标记，durable 事件流之外的行级索引面）。
   */
  recordLastSession(name: string, sessionId: string, now: number): void {
    this.connection
      .prepare(`UPDATE jobs SET last_session_id = ?, updated_at = ? WHERE name = ?`)
      .run(sessionId, now, name);
  }

  /**
   * 声明会话投递目标（v9 列 session_id——投递二值拍板①：null = 子进程单发；
   * K2-c 命令面写入，此处只收 DAO 写路）。
   */
  setSessionTarget(name: string, sessionId: string | null, now: number): void {
    this.connection.prepare(`UPDATE jobs SET session_id = ?, updated_at = ? WHERE name = ?`).run(sessionId, now, name);
  }
}
