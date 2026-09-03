/**
 * L5 app — crash-log：崩溃证据落盘（基建大扫 20260901 第五十七批 #52）。
 *
 * 背景：五入口（tui / run / attach / daemon / tick）的 onFatal 只走 stderr 的
 * logger——前台形态终端一关证据即蒸发，崩溃排障只剩零手材料。本模块补「盘上
 * 第一手证据」：致命路径**同步**追写一行 JSON 至 `<数据目录>/crash.log`（与
 * boot-failures.json 同族——boot 面整替写、崩溃面按次追加）。
 *
 * 纪律对齐（技术栈篇 §6 红线的崩溃侧补位）：crash.log 是**诊断辅助非正确性
 * 承载**——正确性兜底仍是事件日志恢复协议（骨架篇 §1.3 原话）；本文件 best-
 * effort 吞错（崩溃路径不容二次异常），signals.ts 的 fatalTimeoutMs 赛跑下
 * appendFileSync 的同步小写天然在预算内。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';
import { VERSION } from './version.js';

/** 致命异常种类（与 signals.ts FatalKind 同词——uncaughtException/unhandledRejection） */
export type CrashKind = 'uncaughtException' | 'unhandledRejection';

/** 崩溃发生入口（各入口各记其名——排障时定位是哪个形态崩的；desktop = 桌面首启形态，批 C） */
export type CrashEntry = 'tui' | 'run' | 'attach' | 'daemon' | 'tick' | 'desktop';

/** 单条崩溃记录（error 收任意 throw 形态——Error 取 message+stack、其他入 message） */
export interface CrashRecord {
  readonly kind: CrashKind;
  readonly entry: CrashEntry;
  readonly error: unknown;
}

/** 单条记录 stack 的截断帽（字节）——病态深栈不撑爆 crash.log（8 KiB 够第一手定位） */
const STACK_CAP_BYTES = 8 * 1024;

/**
 * 崩溃证据落盘（best-effort）：同步追写一行 JSON 至 `<数据目录>/crash.log`。
 *
 * @param record 崩溃记录（kind / entry / error）
 * @param dataRoot 数据目录根（缺省 dataDir()——测试钉扎）
 * 任何失败（目录不可建/不可写/序列化炸）静默吞——崩溃路径不二炸；证据蒸发面
 * 交回 stderr logger（两路互为备份）。
 */
export function appendCrashRecord(record: CrashRecord, dataRoot: string = dataDir()): void {
  try {
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    // error 归一：Error 取 message + stack（超帽截断）；非 Error throw 形态入 message、stack 缺席
    const err =
      record.error instanceof Error
        ? {
            message: record.error.message,
            stack:
              record.error.stack === undefined
                ? undefined
                : record.error.stack.length > STACK_CAP_BYTES
                  ? `${record.error.stack.slice(0, STACK_CAP_BYTES)}…（截断）`
                  : record.error.stack,
          }
        : { message: String(record.error) };
    const line = JSON.stringify({
      time: new Date().toISOString(),
      kind: record.kind,
      entry: record.entry,
      pid: process.pid,
      version: VERSION,
      error: err,
    });
    appendFileSync(join(dataRoot, 'crash.log'), `${line}\n`);
  } catch {
    /* 吞——崩溃路径不二炸（见 JSDoc） */
  }
}
