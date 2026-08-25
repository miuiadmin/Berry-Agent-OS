/**
 * L3 scheduler — 模块内类型面（jobs 表行形 + runner 结果面）。
 *
 * TickRunResult 是 exec RunResult 的**结构子集**：spawn 组装上提组合根
 *（内核边界篇 §4.1 席 13 冷读 #2 裁决——scheduler 不依赖 exec），件只
 * 见它需要的四字段，组合根传 runArgv 产物直接结构兼容。
 */

/** jobs 表行（schema.ts DDL 的 TS 镜像——SQL AS 别名映射 camelCase，goal 表族同构） */
export interface JobRecord {
  /** 任务名（主键——用户面词汇） */
  readonly name: string;
  /** 任务指令体（原样传子进程） */
  readonly prompt: string;
  /** 执行目录（NULL = 宿主启动目录；第一刀 add 不设） */
  readonly cwd: string | null;
  /** 触发声明（第一刀存而不执法） */
  readonly schedule: string | null;
  /** 最近触发时刻（Unix 毫秒；从未跑过 = null——抢占比对键） */
  readonly lastRunAt: number | null;
  /** 建行时刻（Unix 毫秒） */
  readonly createdAt: number;
  /** 改行时刻（Unix 毫秒） */
  readonly updatedAt: number;
}

/** runner 结果面（exec RunResult 结构子集——exitCode/stdout/stderr/durationMs） */
export interface TickRunResult {
  /** 子进程退出码（被信号杀 = null） */
  readonly exitCode: number | null;
  /** stdout 尾部（60KiB 预算保尾——spawn 管道护栏） */
  readonly stdout: string;
  /** stderr 尾部 */
  readonly stderr: string;
  /** 跑了多少毫秒 */
  readonly durationMs: number;
}
