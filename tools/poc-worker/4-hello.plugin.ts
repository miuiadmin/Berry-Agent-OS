/**
 * 补票金样插件（hello 过界——桥接协议 v0 子集的完整往返）。
 *
 * 在 worker 域内经 jiti 装载（TS 源码形态，与真实插件同）；apply 接收**桥接 ctx 桩**，
 * 过界调用宿主侧工具。覆盖规范钉死的两隐性假设（契约篇 §1.7 冷读裁决）：
 *   ① 同步面调用——await 形态、底层 ask/result 两跳往返（同步阻抗的实证面）；
 *   ② signal→cancel——AbortSignal 本体不过界（不可克隆），过界的是取消消息。
 */

/** 桥接 ctx 桩的最小形状：真实形态 = 宿主面 ctx.tools 的过界镜像（刀二代理桩的前身） */
export interface CtxStub {
  tools: {
    /** 过界工具调用——同步函数过界结构性不可能，调用点只能以 Promise 面呈现 */
    call(tool: string, args: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
  };
}

/** 插件名（装载器形状校验的 named export 面） */
export const name = 'hello';

/** 毫秒延迟（场景编排用，非产品码） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** apply：跑完两场景并回传结构化报告（编排断言住两侧宿主/桩文件，本件只报事实） */
export default async function apply(ctx: CtxStub): Promise<unknown> {
  // ① 同步面调用：echo 过界往返——调用点 await（同步形态），底层 ask/result 两跳
  const echo = (await ctx.tools.call('echo', { name: 'berry' })) as {
    greeting: string;
  };
  const syncOk = echo.greeting === 'hello, berry!';

  // ② signal→cancel：发起 2s 慢调用，80ms 后本地 abort——
  //    桩在 abort 监听器里本地立即结算（不等宿主往返）并发 {kind:'cancel', callId}
  const ac = new AbortController();
  /** 捕获到的拒绝码（预期 BRIDGE_CANCELLED） */
  let caught: string | null = null;
  const t1 = Date.now();
  const slowP = ctx.tools.call('slow', { durationMs: 2000 }, { signal: ac.signal });
  // 挂 catch 防未处理拒绝；记录拒绝码供断言
  slowP.catch((e: { code?: string }) => {
    caught = e.code ?? null;
  });
  // 让慢调用在宿主侧真正跑起来（有在途工作可取消）
  await delay(80);
  ac.abort();
  // 微任务排空：让 abort 监听器的本地结算与 catch 链生效（setTimeout(0) = 一个宏任务档）
  await delay(0);
  // 纯 abort→本地结算耗时（扣除 80ms 编排延迟）
  const abortSettleMs = Date.now() - t1 - 80;

  // 等宿主侧迟到 result 到达——验证迟到丢弃纪律（桩侧 lateResults 计数）
  await delay(200);
  return { syncOk, cancel: { caught, abortSettleMs } };
}
