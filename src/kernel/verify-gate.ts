/**
 * 12.0 验证闸门 — 当漂移检测报告高偏离时，启动独立验证阻断错误回复。
 *
 * VerifyGate 通过 Brain IPC 发 verify.request，Brain 用 default tier 模型
 * 以对抗性视角验证最终回复是否真正解决了用户问题。
 */

import type { IntentAnchor, VerifyVerdict } from '../contracts/intent.js';
import type { IpcMessage, IpcMessageType } from './types.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('verify-gate');

/** verify.request IPC 载荷 */
export interface VerifyRequestPayload {
  anchor: IntentAnchor;
  draftResponse: string;
}

interface AgentIpc {
  onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void;
  send: (type: IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean;
}

/** 验证超时（默认 5s — 使用 default tier 模型，比 drift check 慢） */
const VERIFY_TIMEOUT_MS = 5000;

export class VerifyGate {
  /**
   * 对最终回复进行独立意图验证。
   * 通过 Brain IPC 调用 verify.request，等待 verify.result。
   * 超时或异常时默认 pass=true（不阻断用户体验）。
   */
  async verify(brainIpc: AgentIpc, anchor: IntentAnchor, draftResponse: string): Promise<VerifyVerdict> {
    return new Promise<VerifyVerdict>((resolve) => {
      const correlationId = genId('vfy');
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.debug({ correlationId }, 'verify timeout, defaulting to pass');
        resolve({ pass: true, reason: '验证超时，默认通过' });
      }, VERIFY_TIMEOUT_MS);

      const handler = (msg: IpcMessage) => {
        if (msg.correlationId !== correlationId || settled) return;
        settled = true;
        clearTimeout(timeoutId);

        const { verdict } = msg.payload as { verdict: VerifyVerdict };
        logger.debug({ correlationId, pass: verdict.pass, reason: verdict.reason?.slice(0, 100) }, 'verify:result');
        resolve(verdict);
      };

      brainIpc.onMessage('verify.result', handler);
      brainIpc.send('verify.request', 'brain', { anchor, draftResponse: draftResponse.slice(0, 5000) } satisfies VerifyRequestPayload, correlationId);
    });
  }
}
