/**
 * L3 web — 装机下载本体（契约篇 §6.10「引擎下载装机」段，第五十四批刀三余量）。
 *
 * `downloadToFile`：URL → 流式落盘（response.body 逐 chunk 进
 * fs.createWriteStream，不整读内存）。与 performFetch 同一卫生前置
 * （requireHttpUrl / assertPublicHost / InflightGates 同单例）但**分账面**：
 * - 字节预算独立 512MiB（WEB_DOWNLOAD_BUDGET_BYTES）——超即断流**删档抛错**，
 *   不截断交付（装机物截断即废——与抓取「保头截断」语义有意分歧）；
 * - 非 2xx / 白名单外 = 立码 WEB_DOWNLOAD_FAILED（与抓取「isError 结果面
 *   永不立码」有意分歧——同上，装机物无截断交付语义）；
 * - 不走三段管道 durable 落账（§1.5.2 ③ 增件段拍板：装机命令面非模型面，
 *   命令自身有 notify 面；caller 归因走 logger）；
 * - SHA256 流式随下载计算记回执——记档不对照（远端 checksum 校验链依赖
 *   同一管道可信度，对照挂账判据 = 首个真实损坏案例）；
 * - 执行帽独立 600s（WEB_DOWNLOAD_TIMEOUT_MS——超帽删档 WEB_DOWNLOAD_FAILED；
 *   与调用方取消（AbortError 原样传播）判别面 = 帽信号标记位）。
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AppError,
  WEB_DOWNLOAD_FAILED,
  WEB_FETCH_FAILED,
  WEB_REDIRECT_LIMIT,
  WEB_URL_INVALID,
} from '../contracts/errors.js';
import { assertPublicHost } from './hygiene.js';
import { requireHttpUrl, type WebFetchDeps } from './fetch-core.js';
import {
  WEB_DOWNLOAD_BUDGET_BYTES,
  WEB_DOWNLOAD_TIMEOUT_MS,
  WEB_MAX_REDIRECTS,
  type WebDownloadResult,
} from './types.js';

/** 下载请求头（与抓取同族——自报身份；accept 只认二进制流装机物） */
const DOWNLOAD_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': 'berry/1.0',
  accept: 'application/octet-stream,application/zip,*/*',
};

/**
 * 装机下载本体（web 件服务面 downloadToFile 的实现——app.ts 直挂）。
 *
 * 卫生序（与抓取同源钉死）：URL 校验 → 白名单+私网校验 → 限流 →
 * 传输（流式落盘 + 字节预算 + 执行帽）→ 重定向循环内重复前四。
 * throw 面：WEB_URL_INVALID / WEB_PRIVATE_TARGET / WEB_REDIRECT_LIMIT /
 * WEB_FETCH_FAILED（网络层）/ WEB_DOWNLOAD_FAILED（预算/非 2xx/白名单外/超帽）；
 * 调用方取消（AbortError）原样传播 + 已写半档删除。
 */
export async function performDownload(
  url: string,
  opts: { destPath: string; allowedHosts: readonly string[]; signal?: AbortSignal; caller?: string },
  deps: WebFetchDeps,
  log?: { debug(message: string): void },
): Promise<WebDownloadResult> {
  const startedAt = Date.now();

  /* ---- 卫生件①：URL 校验（协议白名单——与抓取同一份代码） ---- */
  const initialUrl = requireHttpUrl(url);

  /* ---- 卫生件②：白名单 + 私网校验（白名单是装机域钉死面——首跳即执法） ---- */
  assertHostAllowed(initialUrl.hostname, opts.allowedHosts);
  await assertPublicHost(initialUrl.hostname, deps.lookup);

  /* ---- 执行帽信号（600s——与调用方 signal 合流；帽标记位供 AbortError 判别） ---- */
  const timedOut = { v: false };
  const timeoutSignal = AbortSignal.timeout(WEB_DOWNLOAD_TIMEOUT_MS);
  timeoutSignal.addEventListener(
    'abort',
    () => {
      timedOut.v = true;
    },
    { once: true },
  );
  const signal = opts.signal === undefined ? timeoutSignal : AbortSignal.any([opts.signal, timeoutSignal]);
  let finalUrl = initialUrl; // asTimeout 帽文案引用——先于 try 声明（帽可于任意阶段触发）
  // 帽触发统一出口：AbortError 家族在此二分——帽触发翻译 WEB_DOWNLOAD_FAILED，
  // 调用方取消返回 undefined 交还原样传播路径
  const asTimeout = (err: unknown): AppError | undefined =>
    timedOut.v
      ? new AppError(WEB_DOWNLOAD_FAILED, `下载超执行帽 ${WEB_DOWNLOAD_TIMEOUT_MS}ms（${finalUrl.href}）`)
      : err instanceof Error && err.name === 'AbortError'
        ? undefined
        : undefined;

  /* ---- 卫生件③：限流（与抓取共享同一 InflightGates 单例——第三消费位） ---- */
  const gates = deps.gates;
  const fetchImpl = deps.fetchImpl ?? ((u: string, init: RequestInit) => fetch(u, init));
  let host = initialUrl.host;
  await gates.acquire(host, opts.signal);

  // 半档清理：预算断流/取消/超帽都先删已写部分（装机物不留半态）
  let partPath: string | undefined;
  try {
    let redirects = 0;
    let response: Response;
    /* ---- 卫生件②'：重定向循环（manual 自跟——每跳重复①②③，上限同抓取） ---- */
    for (;;) {
      let current: Response;
      try {
        current = await fetchImpl(finalUrl.href, { redirect: 'manual', signal, headers: DOWNLOAD_HEADERS });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          const timeoutErr = asTimeout(err);
          if (timeoutErr !== undefined) throw timeoutErr;
          throw err; // 调用方取消原样传播
        }
        throw new AppError(
          WEB_FETCH_FAILED,
          `下载 ${finalUrl.href} 网络层失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const location = current.headers.get('location');
      if (current.status >= 300 && current.status < 400 && location !== null) {
        redirects += 1;
        if (redirects > WEB_MAX_REDIRECTS) {
          throw new AppError(WEB_REDIRECT_LIMIT, `下载重定向超 ${WEB_MAX_REDIRECTS} 跳上限（终点未达）`);
        }
        let next: URL;
        try {
          next = new URL(location, finalUrl.href);
        } catch {
          throw new AppError(WEB_URL_INVALID, `下载重定向 Location 不可解析：${location}`);
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new AppError(WEB_URL_INVALID, `下载重定向协议不在白名单：${next.protocol}`);
        }
        // 每跳白名单 + 私网校验（重定向跳出白名单 = 装机域被劫持面，fail-loud）
        assertHostAllowed(next.hostname, opts.allowedHosts);
        await assertPublicHost(next.hostname, deps.lookup);
        if (next.host !== host) {
          gates.release(host);
          host = next.host;
          await gates.acquire(host, opts.signal);
        }
        finalUrl = next;
        continue;
      }
      response = current;
      break;
    }

    /* ---- 卫生件④：非 2xx 立码（装机物——无截断交付语义） ---- */
    if (!(response.status >= 200 && response.status < 300)) {
      throw new AppError(WEB_DOWNLOAD_FAILED, `下载 ${finalUrl.href} 非 2xx（${response.status}）`);
    }

    /* ---- 卫生件⑤：流式落盘（.part 半档 → 计数/哈希/预算 → 完整 rename） ---- */
    partPath = `${opts.destPath}.part`;
    const hash = createHash('sha256'); // 流式哈希随 chunk 进——全文算得记回执
    let bytes = 0;
    let budgetBroken = false;
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    // 计数/哈希/预算三合一中间流（预算超即回调收 AppError 断流——半档由 finally 删）
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.byteLength;
        hash.update(chunk);
        if (bytes > WEB_DOWNLOAD_BUDGET_BYTES) {
          budgetBroken = true;
          cb(new AppError(WEB_DOWNLOAD_FAILED, `下载超独立字节预算 ${WEB_DOWNLOAD_BUDGET_BYTES}（已收 ${bytes}）`));
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(partPath));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        const timeoutErr = asTimeout(err);
        if (timeoutErr !== undefined) throw timeoutErr;
        throw err; // 调用方取消原样传播
      }
      if (budgetBroken) throw err; // 预算断流——AppError 原样上抛（finally 删半档）
      throw new AppError(
        WEB_FETCH_FAILED,
        `下载 ${finalUrl.href} 传输层失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await rename(partPath, opts.destPath); // 原子收口：完整才落正式名
    partPath = undefined;
    log?.debug(
      `装机下载完成：${finalUrl.href} → ${opts.destPath}（${bytes} 字节，${Date.now() - startedAt}ms` +
        `${opts.caller !== undefined ? `，调用方 ${opts.caller}` : ''}）`,
    );
    return {
      url,
      finalUrl: finalUrl.href,
      filePath: opts.destPath,
      bytes,
      sha256: hash.digest('hex'),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (partPath !== undefined) await unlink(partPath).catch(() => {}); // 已删/未写成均静默
    gates.release(host); // 双槽必还（异常/取消/成功统一出口——漏放即泄漏槽位）
  }
}

/** 白名单执法（hostname 精确匹配——空白名单 = 全拒 fail-closed） */
function assertHostAllowed(hostname: string, allowedHosts: readonly string[]): void {
  if (!allowedHosts.includes(hostname)) {
    throw new AppError(WEB_DOWNLOAD_FAILED, `下载域不在白名单（${hostname}；白名单：${allowedHosts.join(', ')}）`);
  }
}
