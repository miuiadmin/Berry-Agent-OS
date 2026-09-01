/**
 * L3 memory — 提取管线即时路（记忆篇 §4：纠正检测，确定性代码零 LLM）。
 *
 * 订阅 session/event 活体镜像（契约篇 §2.2 persist 半边的观察侧），用户消息
 * 命中纠正触发词 → 立即提取 correction 条目（Mercury/Hermes 纠正即时存）。
 * fire-and-forget：提取失败只记日志不抛（绝不炸事件总线，更不炸 run）；
 * 产物经 guardedAddMemory（§8.1 写前扫描）+ store.addMemory（§5 合并管线）——
 * 与工具面完全同路，没有旁门。
 */

import type { Disposer } from '../context/types.js';
import type { AppContext } from '../contracts/app.js';
import { guardedAddMemory, isPollutedTranscript } from './scan.js';
import type { MemoryStore } from './store.js';

/**
 * 纠正触发词表（起草值，§11 随实测调）。保守取向：要求「明确的纠正式」，
 * 普通陈述里的否定词不命中（「这里不对劲」不是纠正，是描述）。
 */
const CORRECTION_TRIGGERS: readonly RegExp[] = [
  // 中文：直接否定上一轮 + 改口 + 制止（「错」必选——「做了/写了」是普通叙述不是纠正）
  /(^|[，。！？,.!?])不对(?:[，。！？,啊呀哦]|$)/,
  /(^|[，。！？,.!?])不是的?(?:[，。！？,啊呀哦]|$)/,
  /我(说|要|指|问)的是/,
  /别再/,
  /(搞|弄|做|写|理解|看|答)错了/,
  /重新(说|写|做|生成|给|组织)/,
  /应?该用(别|另|其)/,
  // 英文：no + 改口 / 判错 / 制止
  /\bno,?\s+(?:that'?s|i\s+(?:meant|said|wanted|asked))/i,
  /\bi\s+meant\b/i,
  /\bthat'?s\s+(?:wrong|not\s+what|incorrect)/i,
  /\byou\s+(?:got\s+it\s+wrong|misunderstood|misread)/i,
  /\b(?:stop|don'?t)\s+(?:using|doing|generating|writing)\b/i,
  /\bwrong\b(?=.*(?:instead|should|use|do))/i,
];

/** 纠正摘要截断上限（字符；summary 是合并比较面，超长无益于判重） */
const SUMMARY_EXCERPT_CAP = 80;
/** 纠正全文截断上限（字符；content 是注入面全文，防超长消息整段入库） */
const CONTENT_CAP = 1000;
/** 即时路提取条目的缺省置信度（用户亲口纠正 = 强证据，起草值） */
const DEFAULT_CONFIDENCE = 0.7;

/**
 * 纠正检测：文本命中任一触发词即判纠正。
 * @returns 摘要用摘录（触发词上下文截断）；非纠正返回 undefined
 */
export function detectCorrection(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const hit = CORRECTION_TRIGGERS.some((regex) => regex.test(trimmed));
  if (!hit) return undefined;
  return trimmed.length > SUMMARY_EXCERPT_CAP ? `${trimmed.slice(0, SUMMARY_EXCERPT_CAP)}…` : trimmed;
}

/**
 * user/message 载荷 content（unknown，UserMessageData 契约）→ 纯文本。
 * 兼容 string 与内容块数组两形态（块取 text 部分拼接，非文本块跳过）。
 */
export function userTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: 'text'; text: string } => {
        const b = block as { type?: unknown; text?: unknown };
        return b?.type === 'text' && typeof b.text === 'string';
      })
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

/** 即时路接线依赖（组合根/应用装配注入） */
export interface CorrectionExtractorOptions {
  /** 记忆库 DAO（写入经 guardedAddMemory → 合并管线） */
  readonly store: MemoryStore;
  /** 提取条目归属（缺省 'global'——纠正的是模型行为，跨项目成立；落码注记 §4） */
  readonly ownerKey?: string;
  /** 置信度覆盖（缺省 0.7 起草值） */
  readonly confidence?: number;
}

/**
 * 接线即时路纠正提取：订阅 session/event，命中纠正的用户消息立即入库。
 * 返回退订器（应用侧经 ctx.effect 挂作用域栈，随 LIFO 回卷）。
 *
 * 事件载荷 = { sessionId, event }（dsh-11 信封规则）——多会话并存时以信封
 * sessionId 溯源，不以事件体自证。
 */
export function attachCorrectionExtractor(ctx: AppContext, opts: CorrectionExtractorOptions): Disposer {
  const ownerKey = opts.ownerKey ?? 'global';
  const confidence = opts.confidence ?? DEFAULT_CONFIDENCE;

  return ctx.on('session/event', (payload: unknown) => {
    // fire-and-forget 纪律：任何异常止步于日志，不上抛（emit 派发虽隔离，本层自兜更稳）
    try {
      const envelope = payload as { sessionId?: unknown; event?: { type?: unknown; seq?: unknown; data?: unknown } };
      if (envelope?.event?.type !== 'user/message') return;
      const data = (envelope.event.data as { content?: unknown; source?: unknown } | undefined) ?? {};
      // 机器源滤除（20260901-d #8，记忆篇 §4）：仅真用户消息入检——source 归因
      // 五值词汇（会话篇 §3.1）里 undefined（缺省读侧视为 'user'）/ 'user' /
      // 'channel:*' 是用户亲口；'app:*'（压缩摘要载体、应用注入）、'schedule'、
      // 'subagent-settled' 是机器载体——命中纠正触发词会被提取成「用户亲口
      // 纠正」（置信度 0.7 = 强证据），污染记忆库语义，一律跳过
      const source = typeof data.source === 'string' ? data.source : undefined;
      if (!(source === undefined || source === 'user' || source.startsWith('channel:'))) {
        return;
      }
      const text = userTextFromContent(data.content);
      if (text === '') return;
      // §4.1 资格检查（与周期路 runReviewOnce 同一函数，零特判）：污染文本整段
      // 拒收——不消毒不降权，污染会话不配产出可信记忆。v1 判据空集恒放行。
      if (isPollutedTranscript(text)) {
        ctx.logger.warn('即时路提取文本污染（§4.1 资格检查）——本轮跳过', {
          sessionId: envelope.sessionId,
        });
        return;
      }
      const excerpt = detectCorrection(text);
      if (!excerpt) return;

      const seq = typeof envelope.event.seq === 'number' ? envelope.event.seq : -1;
      const result = guardedAddMemory(opts.store, {
        ownerKey,
        kind: 'correction',
        summary: `纠正：${excerpt}`,
        content: text.length > CONTENT_CAP ? `${text.slice(0, CONTENT_CAP)}…` : text,
        confidence,
        sourceRefs: [{ sessionId: String(envelope.sessionId ?? ''), seq }],
      });
      if (result.status === 'blocked') {
        // §8.1：log-only 诊断——只记模式名，疑似密钥内容不进日志
        ctx.logger.warn('纠正提取被写前扫描拦截（模式：' + result.pattern + '）', {
          sessionId: envelope.sessionId,
          seq,
        });
        return;
      }
      ctx.logger.debug('纠正提取入库', {
        sessionId: envelope.sessionId,
        seq,
        outcome: result.outcome.outcome,
      });
    } catch (err) {
      ctx.logger.error('纠正提取失败（fire-and-forget，不影响会话）', {
        error: err instanceof Error ? err.stack : String(err),
      });
    }
  });
}
