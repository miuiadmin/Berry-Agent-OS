/**
 * L3 web 单元测试 — 卫生件三件回归锁（SSRF 私网清单 / 在飞限流 / 抓取真值层）
 * + HTML 剥标签简版（契约篇 §1.5.2 验收清单）。
 *
 * mock 停在外部边界：DNS lookup 与底层 fetch 全注入（fetchImpl/lookup 缝），
 * 卫生件本体与限流机构件全真——不 mock 中间层。
 */

import { describe, expect, it } from 'vitest';
import {
  AppError,
  WEB_FETCH_FAILED,
  WEB_PRIVATE_TARGET,
  WEB_REDIRECT_LIMIT,
  WEB_URL_INVALID,
} from '../contracts/errors.js';
import { htmlToText } from './html.js';
import { assertPublicHost, InflightGates, isReservedAddress, type HostLookup } from './hygiene.js';
import { performFetch, runWebFetch, type FetchImpl } from './fetch-core.js';
import { WEB_MAX_GLOBAL_INFLIGHT, WEB_MAX_PER_HOST_INFLIGHT, WEB_TEXT_BUDGET_BYTES } from './types.js';

/* ---------------- 助手 ---------------- */

/** 假 lookup：直接回固定地址表（免真 DNS——外部边界注入） */
const lookupOf =
  (...addresses: string[]): HostLookup =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

/** 公网地址 lookup（8.8.8.8——私网校验默认放行态） */
const publicLookup = lookupOf('8.8.8.8');

/** 断言 AppError 携带指定错误码（私网/超跳等错误面的判定核心） */
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

/** 假 fetch 应答器（一次性 Response；redirect 应答带 Location 头） */
function respond(
  status: number,
  headers: Record<string, string>,
  body: string | ReadableStream<Uint8Array>,
): FetchImpl {
  return async () => new Response(body, { status, headers });
}

/** 302 跳转应答器 */
function redirect(location: string): FetchImpl {
  return respond(302, { location }, '');
}

/** 构造大体积流（chunk 循环到至少超过预算再收尾） */
function bigStream(totalBytes: number, chunkSize = 256 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(size).fill(97)); // 'a' 填充
      sent += size;
    },
  });
}

/** 真 DNS 缺省态下的依赖束形态（lookup/fetchImpl 双注入——单元测试标准形态） */
function deps(overrides: { lookup?: HostLookup; fetchImpl?: FetchImpl } = {}) {
  return {
    gates: new InflightGates(),
    lookup: overrides.lookup ?? publicLookup,
    fetchImpl: overrides.fetchImpl,
  };
}

/* ---------------- htmlToText（剥标签简版——形态转换五步） ---------------- */

describe('htmlToText', () => {
  it('块删三件：script/style/noscript 连正文整体删（清单封闭——三件之外不删块）', () => {
    expect(
      htmlToText(
        '<p>前</p><script>var x = "<div>陷阱"</script><style>.a{color:red}</style><noscript>无 JS</noscript><p>后</p>',
      ),
    ).toBe('前\n\n后'); // 块级开闭双换行 = 段落间空行（保段落结构的行为面）
  });

  it('未闭合尾部块（截断 HTML 悬开 script）——尾部全删不留代码噪声', () => {
    expect(htmlToText('<p>正文</p><script>evil()')).toBe('正文');
  });

  it('HTML 注释删', () => {
    expect(htmlToText('甲<!-- build:note -->乙')).toBe('甲乙');
  });

  it('块级标签转行保段落结构、inline 标签裸剥', () => {
    expect(htmlToText('<div>一</div><div>二</div>')).toBe('一\n\n二');
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('a\n\nb'); // 列表项各自成段
    expect(htmlToText('<p>见 <a href="/x">链接</a> 与 <em>强调</em></p>')).toBe('见 链接 与 强调');
  });

  it('实体解码：命名表 + 十进制 + 十六进制；未知实体原样保留', () => {
    expect(htmlToText('a&amp;b &copy; &#65; &#x42; &foobar;')).toBe('a&b © A B &foobar;');
  });

  it('空白压缩：行内多空格并一、3+ 空行压一、首尾 trim', () => {
    expect(htmlToText('a \t b\n\n\n\nc')).toBe('a b\n\nc');
  });

  it('textarea 内真闭合 script 被块删吞（简版无 RCDATA 语义——锁行为防回归漂移）', () => {
    // 简版不解析 DOM：'<script>x</script>' 无论上下文（含 textarea 文本面）都按
    // 闭合脚本块整体删——丢文本非安全问题，简版声明的接受面
    expect(htmlToText('<textarea><script>x</script></textarea>')).toBe('');
  });
});

/* ---------------- isReservedAddress（IANA 特殊用途段全收） ---------------- */

describe('isReservedAddress', () => {
  it('IPv4 保留段全覆盖（含 TEST-NET 三段/CGNAT/benchmark/链路本地云元数据）', () => {
    for (const address of [
      '0.0.0.1', // 「本网络」段
      '10.1.2.3', // RFC1918 A
      '100.64.0.1', // CGNAT
      '127.0.0.1', // 环回
      '169.254.169.254', // 链路本地（云元数据端点——SSRF 经典目标）
      '172.16.0.1', // RFC1918 B 下界
      '172.31.255.255', // RFC1918 B 上界
      '192.0.0.1', // IETF 协议地址
      '192.0.2.1', // TEST-NET-1
      '192.168.1.1', // RFC1918 C
      '198.18.5.5', // benchmark 段（198.18/15 下界）
      '198.19.200.1', // benchmark 段上界
      '198.51.100.7', // TEST-NET-2
      '203.0.113.9', // TEST-NET-3
      '224.0.0.1', // 组播
      '240.0.0.1', // 保留段
      '255.255.255.255', // 广播（保留段含）
    ]) {
      expect(isReservedAddress(address), address).toBe(true);
    }
  });

  it('IPv4 公网段边界外放行（172.15/172.32、198.17/198.20——段表边界不误伤）', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '198.17.0.1', '198.20.0.1']) {
      expect(isReservedAddress(address), address).toBe(false);
    }
  });

  it('IPv6 保留段全覆盖（环回/ULA/链路本地/discard/文档/Teredo/6to4/组播）', () => {
    for (const address of [
      '::', // 未指定
      '::1', // 环回
      '100::1', // discard 段
      '2001:0:1234::1', // Teredo（2001::/32——非 db8）
      '2001:db8::1', // 文档段
      '2002:8d8:8d8::1', // 6to4 整段拒（内嵌公网 141.8.141.8 也拒）
      'fc00::1', // ULA 下界
      'fd12:3456::1', // ULA（fd 前缀在 fc00::/7 内）
      'fe80::1', // 链路本地
      'ff02::1', // 组播
    ]) {
      expect(isReservedAddress(address), address).toBe(true);
    }
  });

  it('IPv6 公网放行', () => {
    for (const address of ['2600::1', '2001:4860:4860::8888']) {
      expect(isReservedAddress(address), address).toBe(false);
    }
  });

  it('映射段（IPv4-mapped/NAT64）内嵌地址过 v4 清单：dotted 与 hex 同一逻辑地址同一判定', () => {
    expect(isReservedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isReservedAddress('::ffff:169.254.1.1')).toBe(true);
    expect(isReservedAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isReservedAddress('64:ff9b::127.0.0.1')).toBe(true); // NAT64 映射私网
    expect(isReservedAddress('64:ff9b::8.8.8.8')).toBe(false); // NAT64 映射公网
    // hex 写法 = 同一逻辑地址同一判定（落码批修死：BlockList 不可收 ::ffff:0:0/96
    // 条目——会把全部 IPv4 判定毒化为命中，映射段改文本前缀提取）
    expect(isReservedAddress('::ffff:7f00:1')).toBe(true); // = ::ffff:127.0.0.1
    expect(isReservedAddress('::ffff:102:304')).toBe(false); // = ::ffff:1.2.3.4（公网放行）
    expect(isReservedAddress('64:ff9b::0a00:1')).toBe(true); // = 64:ff9b::10.0.0.1
    // 映射前缀 + 畸形尾部 / 裸前缀 = fail-closed 拒
    expect(isReservedAddress('::ffff:zz')).toBe(true);
    expect(isReservedAddress('64:ff9b::')).toBe(true);
  });

  it('非法 IP 文本 fail-closed（解析不了的一律不去碰）', () => {
    for (const text of ['example.com', '', '999.999.999.999', '1.2.3']) {
      expect(isReservedAddress(text), text).toBe(true);
    }
  });
});

/* ---------------- assertPublicHost（DNS 全地址过清单） ---------------- */

describe('assertPublicHost', () => {
  it('全公网地址放行', async () => {
    await expect(assertPublicHost('ok.example', lookupOf('8.8.8.8', '1.1.1.1'))).resolves.toBeUndefined();
  });

  it('多 A 记录混布（任一私网即拒——CDN 混布私网地址的 SSRF 绕行）', async () => {
    await expectCode(assertPublicHost('evil.example', lookupOf('8.8.8.8', '10.0.0.1')), WEB_PRIVATE_TARGET);
  });

  it('DNS 解析失败 = 网络层失败（错误码与私网拒分立）', async () => {
    const failing: HostLookup = async () => {
      throw new Error('ENOTFOUND');
    };
    await expectCode(assertPublicHost('gone.example', failing), WEB_FETCH_FAILED);
  });

  it('DNS 解析为零地址 = 网络层失败', async () => {
    await expectCode(assertPublicHost('void.example', lookupOf()), WEB_FETCH_FAILED);
  });
});

/* ---------------- InflightGates（全局 8 / 每主机 2 信号量） ---------------- */

describe('InflightGates', () => {
  it('每主机上限 2：第三次同主机排队（不拒绝）', async () => {
    const gates = new InflightGates();
    await gates.acquire('a.example'); // 槽 1
    await gates.acquire('a.example'); // 槽 2（满）
    let granted = false;
    const pending = gates.acquire('a.example').then(() => {
      granted = true;
    });
    await Promise.resolve(); // 微任务一轮——排队者不该被授予
    expect(granted).toBe(false);
    gates.release('a.example'); // 释放回填
    await pending;
    expect(granted).toBe(true);
  });

  it('全局上限 8：跨 8 主机满后第 9 个（新主机）排队', async () => {
    const gates = new InflightGates();
    for (let i = 0; i < WEB_MAX_GLOBAL_INFLIGHT; i++) await gates.acquire(`h${i}.example`);
    let granted = false;
    const pending = gates.acquire('h9.example').then(() => {
      granted = true;
    });
    await Promise.resolve();
    expect(granted).toBe(false);
    gates.release('h0.example');
    await pending;
    expect(granted).toBe(true);
  });

  it('每主机上限常量 = 2（规范数值面锁死）', () => {
    expect(WEB_MAX_PER_HOST_INFLIGHT).toBe(2);
  });

  it('排队中 abort：立即出队取消（AbortError）且不消耗信号量', async () => {
    const gates = new InflightGates();
    await gates.acquire('a.example');
    await gates.acquire('a.example'); // 主机满
    const controller = new AbortController();
    const pending = gates.acquire('a.example', controller.signal);
    controller.abort(); // 排队中取消——出队不占槽
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // 不消耗信号量证明：释放一槽后新 acquire 立即授予（若 abort 吞了槽，inflight 已负/错位）
    gates.release('a.example');
    await gates.acquire('a.example'); // 立即授予（不 pending）
  });

  it('回填跳过主机被占的前排（不队头阻塞）：前排同主机满、次排他主机得槽', async () => {
    const gates = new InflightGates();
    // hostA 双槽满 + 六个其他主机各 1 → 全局 8 满
    await gates.acquire('a.example');
    await gates.acquire('a.example');
    for (let i = 0; i < 6; i++) await gates.acquire(`other${i}.example`);
    // 前排 = hostA（主机满不可授予）；次排 = other0（每主机还有 1 槽）
    let frontGranted = false;
    let rearGranted = false;
    const front = gates.acquire('a.example').then(() => {
      frontGranted = true;
    });
    gates.acquire('other0.example').then(() => {
      rearGranted = true;
    });
    gates.release('other1.example'); // 释放他主机槽 → 全局 7
    await Promise.resolve();
    await Promise.resolve();
    expect(frontGranted).toBe(false); // hostA 仍满——跳过
    expect(rearGranted).toBe(true); // 次排得槽（不队头阻塞）
    void front; // 前排继续等（不断言其后续——留给 finally 语义）
    gates.release('a.example');
  });
});

/* ---------------- performFetch / runWebFetch（真值层 + 工具面文本组装） ---------------- */

describe('performFetch 真值层', () => {
  it('200 text/plain 直达：九字段全产出（url/finalUrl 同、redirects 0、truncated false）', async () => {
    const lookups: string[] = [];
    const lookup: HostLookup = async (hostname) => {
      lookups.push(hostname);
      return [{ address: '8.8.8.8', family: 4 }];
    };
    const outcome = await performFetch(
      { url: 'https://ok.example/doc' },
      undefined,
      deps({ lookup, fetchImpl: respond(200, { 'content-type': 'text/plain; charset=utf-8' }, '正文') }),
    );
    expect(outcome.binary).toBe(false);
    expect(outcome.result).toMatchObject({
      url: 'https://ok.example/doc',
      finalUrl: 'https://ok.example/doc',
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      text: '正文',
      bytes: 6,
      truncated: false,
      redirects: 0,
    });
    expect(typeof outcome.result.durationMs).toBe('number');
    expect(lookups).toEqual(['ok.example']); // 卫生件① DNS 半边已过
  });

  it('HTML 剥标签（content-type 判定桶 → htmlToText 形态转换）', async () => {
    const outcome = await performFetch(
      { url: 'https://ok.example/' },
      undefined,
      deps({
        fetchImpl: respond(
          200,
          { 'content-type': 'text/html' },
          '<html><body><p>你好 <b>世界</b></p><script>no()</script></body></html>',
        ),
      }),
    );
    expect(outcome.result.text).toBe('你好 世界');
  });

  it('application/json 认文本桶（原文返回不剥标签）', async () => {
    const outcome = await performFetch(
      { url: 'https://ok.example/a.json' },
      undefined,
      deps({ fetchImpl: respond(200, { 'content-type': 'application/json' }, '{"a":1}') }),
    );
    expect(outcome.binary).toBe(false);
    expect(outcome.result.text).toBe('{"a":1}');
  });

  it('非文本桶：binary 标注 + text 空串（不引二进制消费面）', async () => {
    const outcome = await performFetch(
      { url: 'https://ok.example/blob' },
      undefined,
      deps({
        fetchImpl: respond(
          200,
          { 'content-type': 'application/octet-stream' },
          new Uint8Array([0, 1]).toString() as string,
        ),
      }),
    );
    expect(outcome.binary).toBe(true);
    expect(outcome.result.text).toBe('');
  });

  it('URL 畸形与非 http(s) 协议 → WEB_URL_INVALID（file/ws 一律拒）', async () => {
    await expectCode(performFetch({ url: '不是 URL' }, undefined, deps()), WEB_URL_INVALID);
    await expectCode(performFetch({ url: 'file:///etc/passwd' }, undefined, deps()), WEB_URL_INVALID);
    await expectCode(performFetch({ url: 'ws://x.example/' }, undefined, deps()), WEB_URL_INVALID);
  });

  it('初始目标解析到私网 → WEB_PRIVATE_TARGET 且不触底层 fetch', async () => {
    let fetched = false;
    const fetchImpl: FetchImpl = async () => {
      fetched = true;
      return new Response('');
    };
    await expectCode(
      performFetch({ url: 'https://internal.example/' }, undefined, deps({ lookup: lookupOf('10.0.0.5'), fetchImpl })),
      WEB_PRIVATE_TARGET,
    );
    expect(fetched).toBe(false); // 卫生件先于出网
  });

  it('重定向链：manual 自跟、相对 Location 基准解析、每跳重过私网校验', async () => {
    const lookups: string[] = [];
    const lookup: HostLookup = async (hostname) => {
      lookups.push(hostname);
      return [{ address: '8.8.8.8', family: 4 }];
    };
    const fetchImpl: FetchImpl = async (url) => {
      if (url === 'https://a.example/start') return new Response('', { status: 302, headers: { location: 'next' } }); // 相对 → a.example/next
      if (url === 'https://a.example/next')
        return new Response('', { status: 301, headers: { location: 'https://b.example/end' } }); // 绝对换主机
      return new Response('终点', { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    const outcome = await performFetch({ url: 'https://a.example/start' }, undefined, deps({ lookup, fetchImpl }));
    expect(outcome.result).toMatchObject({
      finalUrl: 'https://b.example/end',
      redirects: 2,
      text: '终点',
      status: 200,
    });
    // 每跳私网校验：初始 + 302 相对跳 + 301 换主机跳 = 三次 DNS 过检
    expect(lookups).toEqual(['a.example', 'a.example', 'b.example']);
  });

  it('重定向跳私网 → WEB_PRIVATE_TARGET（公网页 302 到内网地址的经典 SSRF 绕行被拦）', async () => {
    // 按主机分址：ok.example 公网放行、evil.internal 解析私网（重定向目标）
    const lookup: HostLookup = async (hostname) =>
      hostname === 'evil.internal' ? [{ address: '192.168.1.10', family: 4 }] : [{ address: '8.8.8.8', family: 4 }];
    const fetchImpl: FetchImpl = async () =>
      new Response('', { status: 302, headers: { location: 'http://evil.internal/admin' } });
    await expectCode(
      performFetch({ url: 'https://ok.example/' }, undefined, deps({ lookup, fetchImpl })),
      WEB_PRIVATE_TARGET,
    );
  });

  it('重定向协议降级（跳 ftp:）→ WEB_URL_INVALID', async () => {
    const fetchImpl: FetchImpl = async () =>
      new Response('', { status: 302, headers: { location: 'ftp://x.example/f' } });
    await expectCode(performFetch({ url: 'https://ok.example/' }, undefined, deps({ fetchImpl })), WEB_URL_INVALID);
  });

  it('重定向超 5 跳上限 → WEB_REDIRECT_LIMIT', async () => {
    let hops = 0;
    const fetchImpl: FetchImpl = async (url) => {
      hops += 1;
      return new Response('', { status: 302, headers: { location: `${url}x` } }); // 无限跳
    };
    await expectCode(performFetch({ url: 'https://ok.example/' }, undefined, deps({ fetchImpl })), WEB_REDIRECT_LIMIT);
    expect(hops).toBe(6); // 5 跳允许 + 第 6 跳触发上限
  });

  it('网络层失败 → WEB_FETCH_FAILED；调用方 AbortError 原样透传', async () => {
    const broken: FetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    await expectCode(
      performFetch({ url: 'https://ok.example/' }, undefined, deps({ fetchImpl: broken })),
      WEB_FETCH_FAILED,
    );
    const aborted: FetchImpl = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    // AbortError 不是 AppError——name 断言（主动取消不是失败）
    await performFetch({ url: 'https://ok.example/' }, undefined, deps({ fetchImpl: aborted })).then(
      () => {
        throw new Error('期望透传 AbortError');
      },
      (err: unknown) => {
        expect((err as Error).name).toBe('AbortError');
      },
    );
  });

  it('网络读 2 MiB 硬顶：流式断流 + truncated 标注（bytes 记截断前计数）', async () => {
    const outcome = await performFetch(
      { url: 'https://ok.example/big' },
      undefined,
      deps({ fetchImpl: respond(200, { 'content-type': 'text/plain' }, bigStream(3 * 1024 * 1024)) }),
    );
    expect(outcome.result.truncated).toBe(true);
    expect(outcome.result.bytes).toBeGreaterThanOrEqual(2 * 1024 * 1024); // 截断前计数
    expect(Buffer.byteLength(outcome.result.text)).toBe(WEB_TEXT_BUDGET_BYTES); // 产出面 60 KiB 保头
  });

  it('产出文本 60 KiB 保头截断（网络读未超顶、文本面超顶）', async () => {
    const body = 'a'.repeat(100 * 1024); // 100 KiB 文本（< 2 MiB 网络预算）
    const outcome = await performFetch(
      { url: 'https://ok.example/text' },
      undefined,
      deps({ fetchImpl: respond(200, { 'content-type': 'text/plain' }, body) }),
    );
    expect(outcome.result.bytes).toBe(100 * 1024); // 网络读完整
    expect(outcome.result.truncated).toBe(true); // 文本面截断
    expect(Buffer.byteLength(outcome.result.text)).toBe(WEB_TEXT_BUDGET_BYTES);
  });

  it('限流槽位必还：同件并发抓取结束后可再抓（finally release 无泄漏）', async () => {
    const base = deps();
    const first = performFetch({ url: 'https://ok.example/1' }, undefined, {
      ...base,
      fetchImpl: respond(200, { 'content-type': 'text/plain' }, '一'),
    });
    const second = performFetch({ url: 'https://ok.example/2' }, undefined, {
      ...base,
      fetchImpl: respond(200, { 'content-type': 'text/plain' }, '二'),
    });
    const both = await Promise.all([first, second]); // 同主机 2 槽并飞
    expect(both.map((o) => o.result.text)).toEqual(['一', '二']);
    // 第三发立即成功 = 前两发槽位已还（若泄漏则第三次排队 pending → 测试超时红）
    const third = await performFetch({ url: 'https://ok.example/3' }, undefined, {
      ...base,
      fetchImpl: respond(200, { 'content-type': 'text/plain' }, '三'),
    });
    expect(third.result.text).toBe('三');
  });
});

describe('runWebFetch 工具面（文本组装层）', () => {
  it('成功：元数据头 + 分隔线 + 正文；details 带九字段', async () => {
    const result = await runWebFetch(
      { url: 'https://ok.example/' },
      undefined,
      deps({ fetchImpl: respond(200, { 'content-type': 'text/plain' }, '内容') }),
    );
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('[fetch 200] https://ok.example/');
    expect(text).toContain('----------------'); // 分隔线
    expect(text.endsWith('内容')).toBe(true);
    expect(result.details).toMatchObject({ status: 200, url: 'https://ok.example/' });
  });

  it('HTTP 非 2xx = isError 结果面（不 throw——模型可判断重试策略）', async () => {
    const result = await runWebFetch(
      { url: 'https://ok.example/missing' },
      undefined,
      deps({ fetchImpl: respond(404, { 'content-type': 'text/plain' }, '没有') }),
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('[fetch 404]');
  });

  it('非文本响应 = isError + 结构说明（binary 不进正文）', async () => {
    const result = await runWebFetch(
      { url: 'https://ok.example/img.png' },
      undefined,
      deps({ fetchImpl: respond(200, { 'content-type': 'image/png' }, '�') }),
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('非文本响应');
  });

  it('截断标注出现在文本面（60KiB 保头说明给模型看）', async () => {
    const result = await runWebFetch(
      { url: 'https://ok.example/big' },
      undefined,
      deps({ fetchImpl: respond(200, { 'content-type': 'text/plain' }, 'a'.repeat(100 * 1024)) }),
    );
    expect((result.content[0] as { text: string }).text).toContain('已保头截断');
  });

  it('异常面透传真值层（私网目标 throw WEB_PRIVATE_TARGET——工具面不吞）', async () => {
    await expectCode(
      runWebFetch({ url: 'https://internal.example/' }, undefined, deps({ lookup: lookupOf('192.168.0.10') })),
      WEB_PRIVATE_TARGET,
    );
  });
});

/* ---------------- redirect 应答器的 Response body 空串形态自证 ---------------- */

describe('redirect 助手形态自证（302 无 body 也走 Response 构造面）', () => {
  it('redirect() 产 302 + Location 头', async () => {
    const impl = redirect('https://b.example/');
    const response = await impl('https://a.example/', {});
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://b.example/');
  });
});
