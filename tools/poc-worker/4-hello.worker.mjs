/**
 * 补票 worker 侧：jiti 装载 TS 金样插件 + 桥接 ctx 桩（协议 v0 子集 ask/result/cancel）。
 *
 * 桩是本炮的主角——真实刀二代之以 bridge 模块的通用代理桩，此处手写最小版验证语义：
 *   - ask 发起：callId 递增、entry 入 pending 表；
 *   - result 收取：按 callId 结算；无 entry = 迟到结果（本地已取消结算）→ 丢弃并计数；
 *   - abort 处理：AbortSignal 不可克隆 → 过界的是 {kind:'cancel', callId} 消息；
 *     本地立即结算（拒绝 BRIDGE_CANCELLED），宿主稍后的 result 由迟到分支吸收。
 */
import { createJiti } from 'jiti';
import { parentPort } from 'node:worker_threads';

const port = parentPort;
// worker realm 自建 jiti 实例（moduleCache:false，与宿主装载器同款）
const jiti = createJiti(import.meta.url, { moduleCache: false });

/** 桩侧观测计数：lateResults = 已取消调用的宿主迟到 result 被丢弃的次数 */
const stats = { lateResults: 0 };
/** callId 发号器（worker 域内单调递增） */
let nextCallId = 1;
/** 在途调用表：callId -> { resolve, reject, settled } */
const pending = new Map();

port.on('message', (m) => {
  if (m.kind !== 'result') return;
  const entry = pending.get(m.callId);
  if (!entry) {
    // 迟到结果：本地已因 cancel 结算——丢弃（纪律：迟到不复活、不二次结算）
    stats.lateResults++;
    return;
  }
  pending.delete(m.callId);
  if (entry.settled) return;
  entry.settled = true;
  if (m.ok) entry.resolve(m.value);
  else
    entry.reject(
      Object.assign(new Error(m.error?.message ?? 'bridge error'), {
        code: m.error?.code,
      }),
    );
});

/** 桥接 ctx 桩：插件眼里的 ctx.tools 过界镜像 */
const ctxStub = {
  tools: {
    /**
     * 过界工具调用——调用点同步形态、底层 ask/result 往返。
     * @param tool 工具名（宿主侧注册面）
     * @param args 参数（须结构化克隆可过界）
     * @param opts.signal 可选 AbortSignal——本体永不过界，abort 时转取消消息
     */
    async call(tool, args, opts = {}) {
      const callId = nextCallId++;
      const entry = { settled: false };
      const promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      pending.set(callId, entry);
      if (opts.signal) {
        opts.signal.addEventListener(
          'abort',
          () => {
            if (entry.settled) return; // 结果先到、abort 后到：无事可做
            entry.settled = true;
            pending.delete(callId);
            // 取消消息化：宿主据此掐断在途工作；本地立即结算不等往返
            port.postMessage({ kind: 'cancel', callId });
            entry.reject(Object.assign(new Error('cancelled'), { code: 'BRIDGE_CANCELLED' }));
          },
          { once: true },
        );
      }
      port.postMessage({ kind: 'ask', callId, tool, args });
      return promise;
    },
  },
};

port.on('message', async (m) => {
  if (m.cmd !== 'run') return;
  // 装载金样插件并喂桩——apply 跑两场景（同步面调用 + signal→cancel）
  const mod = await jiti.import(m.pluginPath);
  const report = await mod.default(ctxStub);
  port.postMessage({ stage: 'done', report, stubStats: { ...stats } });
});
