/**
 * L5 app — 跨会话 allowlist 用户配置层存储（骨架篇 §8.4 粘性第 3 条 + 第二十四批
 * 题1a 接线批 Commit A）。
 *
 * 形态：`<数据目录>/allowlist.json`（用户配置层——非项目层，项目仓库携带的声明
 * 不替用户盖章纪律）；JSON `{ version: 1, entries: AllowlistEntry[] }`；原子写
 * （persist writeAtomicFile 同源——禁双实现漂移）。
 *
 * 与守门行的接线形态：store 持**活数组**引用交给 installSafetyGate 的
 * `opts.allowlist`——add/remove 原地改数组（splice 不换引用），守门行逐调用
 * 读取即见最新表，无需重装。损坏/缺省文件 = 空表起步 + warn（隔离 ≠ 静默）。
 * 装配接线（paths 解析 + installSafetyGate 传参 + /allowlist 命令面）= Commit B，
 * 随序 6 tools 行树化落地后接（战区协调 2026-08-26）。
 */

import { readFileSync } from 'node:fs';
import { writeAtomicFile } from '../persist/index.js';
import type { AllowlistEntry } from '../safety/index.js';

/** 存储文件形状（version 字段供未来形态演进——v1 拒绝式校验未知版本） */
interface AllowlistFile {
  version: 1;
  entries: AllowlistEntry[];
}

/** 条目校验（拒绝式：形状不合法即拒载——宁空表不猜测） */
function isValidEntry(value: unknown): value is AllowlistEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['tool'] === 'string' &&
    entry['tool'].length > 0 &&
    typeof entry['pattern'] === 'string' &&
    (entry['expiresAt'] === undefined || typeof entry['expiresAt'] === 'number')
  );
}

/** warn 出口注入（装配层传 logger；缺省 console——测试/诊断面） */
export interface AllowlistStoreOptions {
  readonly warn?: (message: string) => void;
}

/** allowlist 用户配置层存储（活数组 + 原子写） */
export class AllowlistStore {
  private readonly path: string;
  private readonly warn: (message: string) => void;
  /** 活数组（交给守门行的同一引用——add/remove 原地改） */
  private readonly live: AllowlistEntry[] = [];

  constructor(path: string, opts: AllowlistStoreOptions = {}) {
    this.path = path;
    this.warn = opts.warn ?? ((message) => console.warn(message));
    this.load();
  }

  /** 读侧：守门行吃的活数组（只读视图约定——写走 add/remove） */
  get entries(): readonly AllowlistEntry[] {
    return this.live;
  }

  /** 枚举打印面（/allowlist 命令与诊断用——含过期态标注的原料） */
  list(): readonly AllowlistEntry[] {
    return [...this.live];
  }

  /** 追加条目（去重：tool+pattern 全同且都未过期即拒 false——幂等面） */
  add(entry: AllowlistEntry): boolean {
    const duplicate = this.live.some((existing) => existing.tool === entry.tool && existing.pattern === entry.pattern);
    if (duplicate) return false;
    this.live.push(entry);
    this.persist();
    return true;
  }

  /** 按序号移除（revoke 面；越界 false） */
  remove(index: number): boolean {
    if (index < 0 || index >= this.live.length) return false;
    this.live.splice(index, 1);
    this.persist();
    return true;
  }

  /** 起始装载：缺省/损坏 = 空表起步 + warn（不炸启动——allowlist 是增益面非事实源） */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf-8');
    } catch {
      return; // 缺省文件：空表（首次使用）
    }
    try {
      const parsed = JSON.parse(raw) as Partial<AllowlistFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error('version 或 entries 形状不合法');
      }
      const valid = parsed.entries.filter(isValidEntry);
      if (valid.length !== parsed.entries.length) {
        this.warn(`allowlist 文件含 ${parsed.entries.length - valid.length} 条形状不合法条目——已跳过`);
      }
      this.live.push(...valid);
    } catch (err) {
      this.warn(`allowlist 文件损坏，空表起步（原文件保留待人工处置）：${String(err)}`);
    }
  }

  /** 落盘（原子写；写失败 warn 不抛——内存表仍生效，下次变更重试） */
  private persist(): void {
    const file: AllowlistFile = { version: 1, entries: [...this.live] };
    try {
      writeAtomicFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
    } catch (err) {
      this.warn(`allowlist 落盘失败（内存表仍生效）：${String(err)}`);
    }
  }
}
