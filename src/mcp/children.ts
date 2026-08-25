/**
 * L3 mcp — 子进程登记簿 + 启动期孤儿清扫（契约篇 §6.6 子进程治理条；
 * Hermes 探矿轮九 #26/#28 修法）。
 *
 * 为什么需要：MCP 子进程 detached 建组（树杀前提）→ 宿主猝死时子进程**不随死**；
 * 登记簿让下一个宿主启动时能认领清扫（flock 方案与允许双开冲突，不采——
 * hostPid 活性检查即双开安全：兄弟宿主的条目 hostPid 活，不碰）。
 *
 * 物理形态：`<dataDir>/mcp/children.json`，条目数组 `{hostPid, childPid,
 * server, command}`；spawn 即写、净退即删；写走 tmp+rename 原子换（双开下
 * 最后一写胜出——丢失窗口只影响清扫完备性，不损正确性）。
 *
 * PID 复用防护：kill 前经 `ps -p <pid> -o command=` 验命令行含登记的
 * command——不含（PID 被系统复用给无辜进程）即只删条目不动手。
 */

import { renameSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';

/** 登记簿条目（hostPid = 写入此条的宿主进程） */
export interface ChildRegistryEntry {
  /** 写入侧宿主 pid（活性检查对象——不活即猝死遗留） */
  readonly hostPid: number;
  /** MCP 子进程 pid（清扫对象） */
  readonly childPid: number;
  /** 服务器名（诊断归因） */
  readonly server: string;
  /** 服务器可执行路径（PID 复用防护的比对基线） */
  readonly command: string;
}

/** 清扫动作注入面（测试注入假探针；kill 必填——真调用方注 exec killTree） */
export interface SweepProbes {
  /** pid 是否活着（缺省 process.kill(pid, 0) 探测——抛错即不活） */
  isAlive?: (pid: number) => boolean;
  /** 取 pid 命令行（缺省 `ps -p <pid> -o command=`；平台无 ps 时返回 undefined = 跳过验证直接清） */
  commandOf?: (pid: number) => Promise<string | undefined>;
  /** 树杀（必填——清扫即治理动作，缺省不动手会让报告谎报 killed；真调用方注 exec killTree） */
  kill: (pid: number) => void;
}

/** 清扫结果（人读回执 + 测试断言面） */
export interface SweepReport {
  /** 已树杀的 childPid（猝死宿主的遗留孤儿、命令行验证通过） */
  readonly killed: number[];
  /** 只删条目未动手的 childPid（进程已死 / PID 复用验证不过） */
  readonly reapedRecords: number[];
  /** 保留条目数（hostPid 活 = 兄弟宿主——允许双开，不碰） */
  readonly kept: number;
}

/** 登记簿文件形态（JSON 数组） */
type RegistryFile = ChildRegistryEntry[];

/**
 * 子进程登记簿（一实例一文件路径；读写全量——条目数 = 服务器数，量级无害）。
 */
export class ChildRegistry {
  /** 登记簿文件绝对路径（<dataDir>/mcp/children.json） */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** 读全部条目（文件缺失/损坏 = 空表——清扫语义 fail-open，不阻启动） */
  list(): ChildRegistryEntry[] {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return []; // 首启无文件 / 损坏：等同空表
    }
  }

  /** 原子写全量（tmp + rename——双开下丢失窗口只影响清扫完备性） */
  private writeAll(entries: RegistryFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
  }

  /** spawn 即登记（childPid 即 pid） */
  add(entry: ChildRegistryEntry): void {
    const entries = this.list().filter((it) => it.childPid !== entry.childPid);
    entries.push(entry);
    this.writeAll(entries);
  }

  /** 净退即删（按 childPid 定位——正常关停与崩溃退出两路都走这里） */
  remove(childPid: number): void {
    this.writeAll(this.list().filter((it) => it.childPid !== childPid));
  }

  /**
   * 启动期孤儿清扫（apply 时调用——先于自家 spawn，防自家条目被误清）。
   *
   * 判定序：hostPid 不活（宿主猝死遗留）→ childPid 探活 → 活则验命令行
   * （PID 复用防护）→ 验过才树杀；hostPid 活 = 兄弟宿主，保留不动。
   */
  async sweep(probes: SweepProbes): Promise<SweepReport> {
    const isAlive = probes.isAlive ?? ((pid: number) => isPidAlive(pid));
    const commandOf = probes.commandOf ?? psCommandOf;
    const kill = probes.kill;
    const killed: number[] = [];
    const reaped: number[] = [];
    let kept = 0;
    for (const entry of this.list()) {
      if (isAlive(entry.hostPid)) {
        kept += 1; // 兄弟宿主（允许双开）——不碰
        continue;
      }
      if (!isAlive(entry.childPid)) {
        this.remove(entry.childPid); // 子进程已自行退出——只剩簿记要清
        reapedRecordsIn(reaped, entry.childPid);
        continue;
      }
      // PID 复用防护：命令行不含登记 command = PID 已被复用给无辜进程
      const cmdline = await commandOf(entry.childPid);
      if (cmdline !== undefined && !cmdline.includes(entry.command)) {
        this.remove(entry.childPid);
        reapedRecordsIn(reaped, entry.childPid);
        continue;
      }
      kill(entry.childPid);
      this.remove(entry.childPid);
      killed.push(entry.childPid);
    }
    return { killed, reapedRecords: reaped, kept };
  }
}

/** reaped 数组去重收集（同 pid 理论不重复，防御式） */
function reapedRecordsIn(list: number[], pid: number): void {
  if (!list.includes(pid)) list.push(pid);
}

/** pid 活性探测（signal 0 不真发信号——只探测存在性；EPERM = 活但非属主） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `ps -p <pid> -o command=` 取命令行（darwin/linux；失败返回 undefined = 验证降级放行） */
async function psCommandOf(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], (err, stdout) => {
      resolve(err ? undefined : stdout.trim());
    });
  });
}
