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
  /** 触发声明原样串（三形状 once@/every@/daily@——add 时已过 parse 执法；NULL = 仅手动） */
  readonly schedule: string | null;
  /** 最近触发时刻（Unix 毫秒；从未跑过 = null——抢占比对键） */
  readonly lastRunAt: number | null;
  /** 建行时刻（Unix 毫秒） */
  readonly createdAt: number;
  /** 改行时刻（Unix 毫秒） */
  readonly updatedAt: number;
  /** 最近触发记因（'manual' / 'scheduled' / 'missed'——v9 列，从未判定 = null） */
  readonly lastRunReason: string | null;
  /** 会话投递目标声明（NULL = 子进程单发无归属——投递二值拍板①，v9 列） */
  readonly sessionId: string | null;
  /** 最近触发实际跑出的会话 id（v9 列——任务↔会话精确归属标记，K2-c 回写） */
  readonly lastSessionId: string | null;
  /** 归属行（NULL = /tick 用户任务——存量语义；goal 挂钟行恒 'builtin:goal'，v14 列） */
  readonly owner: string | null;
  /** 归属行内键（goal 挂钟行 = goalId——(owner, owner_key) 联合寻径，v14 列） */
  readonly ownerKey: string | null;
  /** 生命周期位（缺省 true；false = 行留史但 tick 编排让路——终态/降级同笔置 0，v14 列） */
  readonly enabled: boolean;
}

/** 触发记因词汇（last_run_reason 列的合法值——手动 / 到点 / once 迟到记因不跑） */
export type RunReason = 'manual' | 'scheduled' | 'missed';

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
