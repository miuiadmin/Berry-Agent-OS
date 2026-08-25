/**
 * L3 web — SSRF 卫生件核心（契约篇 §1.5.2 ③——一套两消费面）。
 *
 * 两件机构件：
 * 1. 私网段清单判定（node:net BlockList 原生——零手写位运算）：目标
 *    hostname 先 DNS 解析取**全部地址**逐一过检，任一命中即拒
 *    （WEB_PRIVATE_TARGET）；
 * 2. 在飞限流信号量（全局 8 / 每主机 2，排队不拒绝；排队中 abort =
 *    立即出队取消不消耗信号量）。
 *
 * 已知边界（规范挂账）：DNS 预解析与 fetch 连接时系统解析间的 rebinding
 * TOCTOU 窗口 v1 接受——多租户形态落地前 undici 自定义 connect 钉 IP 闭死。
 */

import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6, BlockList } from 'node:net';
import { AppError, WEB_FETCH_FAILED, WEB_PRIVATE_TARGET } from '../contracts/errors.js';
import { WEB_MAX_GLOBAL_INFLIGHT, WEB_MAX_PER_HOST_INFLIGHT } from './types.js';

/* ------------------------------------------------------------------ */
/* 私网/保留段清单（契约篇 §1.5.2 ③-1 钉死——IANA 特殊用途注册表全收）  */
/* ------------------------------------------------------------------ */

/** IPv4 保留段（CIDR 前缀长度表——TEST-NET 三段与 benchmark 段全收不留裁量） */
const IPV4_RESERVED: readonly (readonly [network: string, prefix: number])[] = [
  ['0.0.0.0', 8], // 「本网络」段（含 0.0.0.0）
  ['10.0.0.0', 8], // RFC1918 私网 A
  ['100.64.0.0', 10], // CGNAT 运营商内网
  ['127.0.0.0', 8], // 环回
  ['169.254.0.0', 16], // 链路本地
  ['172.16.0.0', 12], // RFC1918 私网 B
  ['192.0.0.0', 24], // IETF 协议地址
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918 私网 C
  ['198.18.0.0', 15], // benchmark 段
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留（含广播 255.255.255.255）
];

/** IPv6 保留段（Teredo/6to4 过渡段整段拒绝——内嵌 IPv4 可嵌私网，递归校验复杂度不值） */
const IPV6_RESERVED: readonly (readonly [network: string, prefix: number])[] = [
  ['::', 128], // 未指定地址
  ['::1', 128], // 环回
  ['100::', 64], // discard 段
  ['2001::', 32], // Teredo（内嵌 IPv4 整段拒）
  ['2001:db8::', 32], // 文档段
  ['2002::', 16], // 6to4（内嵌 IPv4 整段拒）
  ['fc00::', 7], // ULA
  ['fe80::', 10], // 链路本地
  ['ff00::', 8], // 组播
  // 注意：::ffff:0:0/96（IPv4-mapped）与 64:ff9b::/96（NAT64）**结构性不可入本表**——
  // Node BlockList 收 `::ffff:0:0/96` 条目后会把全部 IPv4 判定毒化为命中（单条即
  // 全灭，2026-08-26 落码批实测修死）；两映射段改下方文本前缀提取，见 isReservedAddress
];

/** 段表 → BlockList（构造期一次性建好，判定零遍历开销） */
function buildBlockList(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of IPV4_RESERVED) list.addSubnet(network, prefix, 'ipv4');
  for (const [network, prefix] of IPV6_RESERVED) list.addSubnet(network, prefix, 'ipv6');
  return list;
}

/** 件级单例（清单静态不变——多实例也只是浪费，不犯错） */
const RESERVED = buildBlockList();

/**
 * 映射段前缀提取（规范 ③-1 修死面：两映射段不走 BlockList 段表，文本前缀
 * 提取内嵌 IPv4 递归过 v4 清单——同一逻辑地址同一判定）。
 * 覆盖 `::ffff:`（IPv4-mapped）与 `64:ff9b::`（NAT64）两前缀、dotted 与
 * hex 两种内嵌写法（`::ffff:1.2.3.4` 与 `::ffff:0102:0304` 同值）；
 * 前缀命中但尾部两形态皆非 = 畸形 → fail-closed 拒。
 */
const MAPPED_PREFIX = /^(?:::ffff:|64:ff9b::)(.*)$/i;
/** 内嵌 IPv4 的 dotted 文本形态（`1.2.3.4` 尾巴） */
const DOTTED_V4_TAIL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** 内嵌 IPv4 的 hex 文本形态（两组 16 位十六进制——`0102:0304` 尾巴） */
const HEX_V4_TAIL = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/**
 * 判定单一地址是否命中保留清单（纯函数——测试面全覆盖的判定核心）。
 * 非法 IP 文本（既非 v4 也非 v6）按保留处理（fail-closed：解析不了的一律不去碰）。
 */
export function isReservedAddress(address: string): boolean {
  const mapped = MAPPED_PREFIX.exec(address);
  if (mapped) {
    const tail = mapped[1]!;
    if (DOTTED_V4_TAIL.test(tail)) return isReservedAddress(tail); // dotted：内嵌地址过 v4 清单（递归一层即止）
    const hex = HEX_V4_TAIL.exec(tail);
    if (hex) {
      // hex：两组 16 位 → 四字节拼 dotted（`::ffff:7f00:1` = `::ffff:127.0.0.1`）
      const high = Number.parseInt(hex[1]!, 16);
      const low = Number.parseInt(hex[2]!, 16);
      return isReservedAddress([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.'));
    }
    return true; // 映射前缀 + 畸形尾部——fail-closed 拒
  }
  if (isIPv4(address)) return RESERVED.check(address, 'ipv4');
  if (isIPv6(address)) return RESERVED.check(address, 'ipv6');
  return true; // 解析不了 = fail-closed 拒
}

/** DNS lookup 注入缝（缺省真解析；测试注入假实现——组合根测试 mock 只停外部边界） */
export type HostLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** 缺省实现：全地址族取全部地址（CDN 多 A 记录全过检——任一私网即拒） */
const defaultLookup: HostLookup = (hostname) =>
  lookup(hostname, { all: true, verbatim: true }).then((rows) =>
    rows.map((row) => ({ address: row.address, family: row.family })),
  );

/**
 * 卫生件①的 DNS 半边：目标 hostname 解析出的**全部地址**过保留清单。
 * 任一命中即抛 WEB_PRIVATE_TARGET（SSRF fence 核心——防域名指向私网的绕行）。
 */
export async function assertPublicHost(hostname: string, resolve: HostLookup = defaultLookup): Promise<void> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolve(hostname);
  } catch (err) {
    // DNS 解析失败 = 网络层失败（目标不存在/解析器不可达——不是私网拒绝，错误码分立）
    throw new AppError(
      WEB_FETCH_FAILED,
      `目标 ${hostname} DNS 解析失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new AppError(WEB_FETCH_FAILED, `目标 ${hostname} DNS 解析为零地址`);
  }
  for (const { address } of addresses) {
    if (isReservedAddress(address)) {
      throw new AppError(
        WEB_PRIVATE_TARGET,
        `目标 ${hostname} 解析到保留地址 ${address}（私网/特殊用途段——SSRF 防线拒绝）`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* 在飞限流（卫生件④——信号量排队不拒绝；v1 无速率窗口）                */
/* ------------------------------------------------------------------ */

/** 排队条目（abort 监听的卸载闭包由 grant/abort 双方竞争移除） */
interface Waiter {
  readonly host: string;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
  readonly signal?: AbortSignal;
  /** abort 监听卸载（grant 时也要卸——防授予后 abort 再触发 reject） */
  off?: () => void;
}

/** 标准取消错误（调用方 signal 主动取消——传播原样，不折算 WEB_* 失败） */
function abortError(): Error {
  const err = new Error('抓取已被调用方取消（AbortSignal）');
  err.name = 'AbortError';
  return err;
}

/**
 * 全局+每主机双层在飞信号量（件级单例——服务与工具两消费面共享同一限流）。
 *
 * 语义（契约篇 §1.5.2 ③-4）：
 * - 全局 < 8 且本主机 < 2 → 立即授予；
 * - 否则 FIFO 排队等待（不拒绝）；排队中 abort → 立即出队取消，不消耗信号量；
 * - 重定向换主机 = 逐跳释放原主机槽再取新槽（调用方责任，见 fetch-core）。
 */
export class InflightGates {
  /** 全局在飞计数 */
  private inflight = 0;
  /** 每主机（host:port 计数键）在飞计数 */
  private perHost = new Map<string, number>();
  /** FIFO 等待队列 */
  private queue: Waiter[] = [];

  /** 取得双槽（排队等待；signal abort 立即出队取消） */
  async acquire(host: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(); // 已取消不占队
    if (this.tryGrant(host)) return;
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { host, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        const onAbort = () => {
          const at = this.queue.indexOf(waiter);
          if (at >= 0) this.queue.splice(at, 1); // 出队（未授予——不消耗信号量）
          reject(abortError());
        };
        waiter.off = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  /** 释放双槽并回填队列（fetch-core 的 finally 责任——漏放即泄漏槽位） */
  release(host: string): void {
    this.inflight -= 1;
    const count = (this.perHost.get(host) ?? 1) - 1;
    if (count > 0) this.perHost.set(host, count);
    else this.perHost.delete(host);
    // 回填：FIFO 找首个可授予者（跳过主机槽被占的前排——不队头阻塞）
    for (let i = 0; i < this.queue.length; i++) {
      const waiter = this.queue[i]!;
      if (this.tryGrant(waiter.host)) {
        this.queue.splice(i, 1);
        waiter.off?.(); // 卸 abort 监听（已授予——abort 交执行段自己响应）
        waiter.resolve();
        return;
      }
    }
  }

  /** 有余量即授予（私有——acquire/release 两入口共用） */
  private tryGrant(host: string): boolean {
    if (this.inflight >= WEB_MAX_GLOBAL_INFLIGHT) return false;
    if ((this.perHost.get(host) ?? 0) >= WEB_MAX_PER_HOST_INFLIGHT) return false;
    this.inflight += 1;
    this.perHost.set(host, (this.perHost.get(host) ?? 0) + 1);
    return true;
  }
}
