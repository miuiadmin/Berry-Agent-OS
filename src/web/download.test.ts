/**
 * L3 web 装机下载测试 — downloadToFile（performDownload）卫生/流式/分账面
 * 回归锁（契约篇 §6.10「引擎下载装机」段，第五十四批刀三余量；
 * 2026-09-01 第五十五批增 C-2/m-1 回归锁——超帽 TimeoutError 分流 +
 * 换轨槽账完整性）。
 *
 * mock 停在外部边界：fetchImpl/lookup 全注入，下载本体与卫生件（SSRF/
 * 白名单/限流/预算）全真——不 mock 中间层。
 */

import { createHash } from 'node:crypto';
import { access, constants, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  WEB_DOWNLOAD_FAILED,
  WEB_PRIVATE_TARGET,
  WEB_REDIRECT_LIMIT,
  WEB_URL_INVALID,
} from '../contracts/errors.js';
import { InflightGates, type HostLookup } from './hygiene.js';
import { performDownload } from './download.js';
import type { FetchImpl } from './fetch-core.js';
import { WEB_DOWNLOAD_BUDGET_BYTES, WEB_MAX_PER_HOST_INFLIGHT } from './types.js';

/* ---------------- 助手（外部边界注入面） ---------------- */

/** 假 lookup：固定地址表（免真 DNS） */
const lookupOf =
  (...addresses: string[]): HostLookup =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

/** 公网地址 lookup（8.8.8.8——私网校验默认放行态） */
const publicLookup = lookupOf('8.8.8.8');

/** 断言 promise 以指定错误码的 AppError 拒绝 */
function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`期望抛 AppError(${code})，实际正常返回`);
    },
    (err) => {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(code);
    },
  );
}

/** 200 二进制流应答（chunks 逐段入流——真流式形态，非整读） */
function okBinary(chunks: readonly Uint8Array[]): FetchImpl {
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'application/zip' } },
    );
}

/** 构造超预算大流（大 chunk 少段——512MiB 级预算测试的时长可控形态） */
function bigStream(totalBytes: number, chunkSize: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(chunkSize).fill(97); // 'a' 填充（单 Buffer 复用免反复分配）
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const take = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(sent + take >= totalBytes ? new Uint8Array(chunk.subarray(0, take)) : chunk);
      sent += take;
    },
  });
}

/** 标准依赖束（gates 单例 + 公网 lookup + 注入 fetchImpl） */
function deps(fetchImpl?: FetchImpl) {
  return { gates: new InflightGates(), lookup: publicLookup, fetchImpl };
}

/** 装机白名单形态（CfT 两域——与 install.ts CFT_ALLOWED_HOSTS 同形） */
const ALLOWED = ['googlechromelabs.github.io', 'storage.googleapis.com'];

/* ---------------- 测试目录 ---------------- */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'berry-download-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 在场判定（半档/正式档残留断言用） */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 正常路径 ---------------- */

describe('performDownload 装机下载', () => {
  it('流式落盘：分 chunk 二进制 → 正式档内容/sha256/字节数回执 + .part 无残留', async () => {
    const payload = Buffer.concat([Buffer.from('Hello ', 'utf8'), Buffer.from([0, 1, 2, 255]), Buffer.from('!')]);
    const dest = join(dir, 'ok.zip');
    const result = await performDownload(
      'https://storage.googleapis.com/ok.zip',
      { destPath: dest, allowedHosts: ALLOWED, caller: 'test' },
      deps(okBinary([payload.subarray(0, 5), payload.subarray(5)])), // 两段流式
    );
    expect(result.url).toBe('https://storage.googleapis.com/ok.zip');
    expect(result.finalUrl).toBe('https://storage.googleapis.com/ok.zip');
    expect(result.filePath).toBe(dest);
    expect(result.bytes).toBe(payload.byteLength);
    // sha256 独立复算对照（流式哈希与全文哈希必须一致）
    expect(result.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // 落盘内容逐字节等 + 原子收口（.part 已 rename 走，无残留）
    expect(await readFile(dest)).toEqual(payload);
    expect(await exists(`${dest}.part`)).toBe(false);
  });

  it('协议白名单外（ftp）→ WEB_URL_INVALID（与抓取同一份 URL 校验）', async () => {
    await expectCode(
      performDownload(
        'ftp://storage.googleapis.com/x.zip',
        { destPath: join(dir, 'x'), allowedHosts: ALLOWED },
        deps(),
      ),
      WEB_URL_INVALID,
    );
  });

  it('首跳白名单外 → WEB_DOWNLOAD_FAILED（装机域钉死面，fail-loud 非降级）', async () => {
    await expectCode(
      performDownload(
        'https://evil.example/x.zip',
        { destPath: join(dir, 'y'), allowedHosts: ALLOWED },
        deps(okBinary([new Uint8Array(1)])),
      ),
      WEB_DOWNLOAD_FAILED,
    );
  });

  it('私网目标 → WEB_PRIVATE_TARGET（与抓取同一私网卫生件）', async () => {
    await expectCode(
      performDownload(
        'https://storage.googleapis.com/x.zip',
        { destPath: join(dir, 'z'), allowedHosts: ALLOWED },
        { gates: new InflightGates(), lookup: lookupOf('10.0.0.9'), fetchImpl: okBinary([new Uint8Array(1)]) },
      ),
      WEB_PRIVATE_TARGET,
    );
  });

  it('非 2xx → WEB_DOWNLOAD_FAILED（装机物无截断交付语义——与抓取 isError 面有意分歧）', async () => {
    const notFound = async () => new Response('gone', { status: 404 });
    await expectCode(
      performDownload(
        'https://storage.googleapis.com/x.zip',
        { destPath: join(dir, 'e1'), allowedHosts: ALLOWED },
        deps(notFound),
      ),
      WEB_DOWNLOAD_FAILED,
    );
  });

  it('重定向跳白名单外 → WEB_DOWNLOAD_FAILED（每跳重过白名单——劫持面 fail-loud）', async () => {
    const hijack: FetchImpl = async () =>
      new Response('', { status: 302, headers: { location: 'https://evil.example/payload.zip' } });
    await expectCode(
      performDownload(
        'https://googlechromelabs.github.io/manifest.json',
        { destPath: join(dir, 'e2'), allowedHosts: ALLOWED },
        deps(hijack),
      ),
      WEB_DOWNLOAD_FAILED,
    );
  });

  it('白名单内跨主机重定向：host 槽换轨跟随 + finalUrl 记终点（CfT 清单域→下载域常态）', async () => {
    const final = 'https://storage.googleapis.com/chrome/138.0.zip';
    const redirectThenOk: FetchImpl = async (url) =>
      url === 'https://googlechromelabs.github.io/point'
        ? new Response('', { status: 302, headers: { location: final } })
        : new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(Buffer.from('ZIPDATA'));
                c.close();
              },
            }),
            { status: 200 },
          );
    const dest = join(dir, 'redirected.zip');
    const result = await performDownload(
      'https://googlechromelabs.github.io/point',
      { destPath: dest, allowedHosts: ALLOWED },
      deps(redirectThenOk),
    );
    expect(result.finalUrl).toBe(final);
    expect((await readFile(dest)).toString('utf8')).toBe('ZIPDATA');
  });

  it('重定向超上限 → WEB_REDIRECT_LIMIT（自环 302——与抓取同帽）', async () => {
    const loop: FetchImpl = async () =>
      new Response('', { status: 302, headers: { location: 'https://storage.googleapis.com/loop' } });
    await expectCode(
      performDownload(
        'https://storage.googleapis.com/loop',
        { destPath: join(dir, 'e3'), allowedHosts: ALLOWED },
        deps(loop),
      ),
      WEB_REDIRECT_LIMIT,
    );
  });
});

/* ---------------- 分账面：预算/半档清理 ---------------- */

describe('performDownload 分账面（装机语义——与抓取有意分歧位）', () => {
  it('超独立字节预算 → WEB_DOWNLOAD_FAILED + 正式档/.part 双无（断流删档，不截断交付）', async () => {
    const dest = join(dir, 'big.zip');
    await expectCode(
      performDownload(
        'https://storage.googleapis.com/big.zip',
        { destPath: dest, allowedHosts: ALLOWED },
        deps(
          async () =>
            new Response(bigStream(WEB_DOWNLOAD_BUDGET_BYTES + 1024 * 1024, 128 * 1024 * 1024), { status: 200 }),
        ),
      ),
      WEB_DOWNLOAD_FAILED,
    );
    expect(await exists(dest)).toBe(false);
    expect(await exists(`${dest}.part`)).toBe(false);
  }, 30_000); // 512MiB 级流式落盘——放宽时长帽

  it('调用方取消：AbortError 原样传播（非 AppError 帽翻译）+ 半档已删', async () => {
    const controller = new AbortController();
    // 应答体永不 close——abort 时经 signal 把流打错（真 fetch 的取消传播形态）
    const hang: FetchImpl = async (_url, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller2) {
            controller2.enqueue(new Uint8Array([1, 2, 3]));
            init.signal?.addEventListener('abort', () => controller2.error(new DOMException('取消', 'AbortError')), {
              once: true,
            });
          },
        }),
        { status: 200 },
      );
    const dest = join(dir, 'cancelled.zip');
    const promise = performDownload(
      'https://storage.googleapis.com/hang.zip',
      { destPath: dest, allowedHosts: ALLOWED, signal: controller.signal },
      deps(hang),
    );
    setTimeout(() => controller.abort(), 20); // 起跑后取消（半档已写 3 字节形态）
    const err = await promise.then(
      () => {
        throw new Error('期望 AbortError 传播');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError'); // 调用方取消——非 600s 帽翻译面
    expect(await exists(dest)).toBe(false);
    expect(await exists(`${dest}.part`)).toBe(false);
  });

  it('失败后限流槽必还：同 gates 再取满每主机并发帽不阻塞（漏放即泄漏槽位）', async () => {
    const gates = new InflightGates();
    const notFound = async () => new Response('', { status: 500 });
    // 一次失败下载走完整 acquire→throw→finally release 路径
    await performDownload(
      'https://storage.googleapis.com/fail.zip',
      { destPath: join(dir, 'f'), allowedHosts: ALLOWED },
      { gates, lookup: publicLookup, fetchImpl: notFound },
    ).catch(() => {}); // 失败即预期——只消费槽位生命周期
    // 释放回归断言：失败后每主机两槽应可立即全取（带超时护栏防伪绿挂死）
    const both = await Promise.race([
      Promise.all(Array.from({ length: WEB_MAX_PER_HOST_INFLIGHT }, () => gates.acquire('storage.googleapis.com'))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('槽位未释放——acquire 挂起')), 500)),
    ]);
    expect(both).toHaveLength(WEB_MAX_PER_HOST_INFLIGHT);
    for (let i = 0; i < WEB_MAX_PER_HOST_INFLIGHT; i += 1) gates.release('storage.googleapis.com'); // 测试自清
  });
});

/* ---------------- 第五十五批回归锁：C-2 超帽分流 + m-1 换轨槽账 ---------------- */

describe('performDownload 超帽与换轨槽序（20260901-c C-2/m-1）', () => {
  it('超执行帽：fetch 层抛 TimeoutError 形（AbortSignal.timeout 真实抛形）→ WEB_DOWNLOAD_FAILED 删档收场（非网络层误装箱）', async () => {
    // C-2：Node fetch 对 AbortSignal.timeout 的抛形是 name='TimeoutError' 的
    // DOMException——旧判据只认 'AbortError'，超帽会被装箱成 WEB_FETCH_FAILED。
    // 帽 600s 不可真等：stub AbortSignal.timeout 为手动可控信号（错误形由
    // fetchImpl 侧构造，同 undici 真实形态），触发即验分流。
    let ctl: AbortController | undefined;
    vi.stubGlobal('AbortSignal', {
      timeout: (_ms: number) => {
        ctl = new AbortController();
        return ctl.signal;
      },
    });
    const timedOutFetch: FetchImpl = (_url, init) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('signal timed out', 'TimeoutError')), {
          once: true,
        });
      });
    const dest = join(dir, 'timeout.zip');
    try {
      const promise = performDownload(
        'https://storage.googleapis.com/hang.zip',
        { destPath: dest, allowedHosts: ALLOWED },
        deps(timedOutFetch),
      );
      await new Promise((r) => setTimeout(r, 10)); // 起跑到 fetch 挂起点（监听器已挂）
      expect(ctl).toBeDefined();
      ctl!.abort(); // 帽触发
      const err = await promise.then(
        () => {
          throw new Error('期望超帽拒载');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(WEB_DOWNLOAD_FAILED); // 修复前此断言红（误落 WEB_FETCH_FAILED）
      expect((err as AppError).message).toContain('超执行帽'); // 帽翻译面（非预算/非 2xx 同码不同因）
      expect(await exists(dest)).toBe(false);
      expect(await exists(`${dest}.part`)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('换轨排队中取消：新主机槽从未取到 → finally 不还（槽账不漂移——第三次取槽仍应排队）', async () => {
    // m-1：旧行为换轨时 host 先行重赋值，取槽被取消后 finally 会 release
    // 从未 acquire 成功的新主机——per-host 计数虚减，后续请求误放行超限。
    const gates = new InflightGates();
    // 预占满新主机每主机并发帽（真实并发持有者——排队面成立的前提）
    for (let i = 0; i < WEB_MAX_PER_HOST_INFLIGHT; i += 1) await gates.acquire('storage.googleapis.com');
    const controller = new AbortController();
    const redirect: FetchImpl = async () =>
      new Response('', { status: 302, headers: { location: 'https://storage.googleapis.com/real.zip' } });
    const dest = join(dir, 'drift.zip');
    const promise = performDownload(
      'https://googlechromelabs.github.io/point2',
      { destPath: dest, allowedHosts: ALLOWED, signal: controller.signal },
      { gates, lookup: publicLookup, fetchImpl: redirect },
    );
    await new Promise((r) => setTimeout(r, 20)); // 走到换轨排队点（旧槽已还、新槽在队）
    controller.abort(); // 排队中取消——hygiene 出队拒绝（AbortError）
    const err = await promise.then(
      () => {
        throw new Error('期望取消传播');
      },
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe('AbortError'); // 调用方取消原样传播
    // 槽账完整性：新主机仍满——下一次取槽应继续排队（修复前 finally 还了
    // 未取到的槽 → 计数虚减 → 立即授予 = 本断言红）
    const probe = gates.acquire('storage.googleapis.com');
    const granted = await Promise.race([
      probe.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 100)),
    ]);
    expect(granted).toBe(false);
    // 清场：还预占槽 → probe 授予 → 还 probe 槽（gates 无泄漏离场）
    for (let i = 0; i < WEB_MAX_PER_HOST_INFLIGHT; i += 1) gates.release('storage.googleapis.com');
    await probe;
    gates.release('storage.googleapis.com');
  });
});
