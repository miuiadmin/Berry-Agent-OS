/**
 * L3 webui — WebuiChannel 单元测试（连接帽/广播/心跳看门狗/closed 自守）。
 *
 * 只 import 本模块与 vitest + node 内建。ServerResponse 以最小桩替身（write/
 * on/destroy 三面），假钟驱动心跳与看门狗（d8e066d 纪律：时钟敏感测试假钟
 * 确定性化——不依赖真墙钟）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { WebuiChannel } from './channel.js';
import { WEBUI_MAX_CONNECTIONS, WEBUI_PING_INTERVAL_MS, WEBUI_WRITE_TIMEOUT_MS } from './types.js';

/**
 * 最小响应流桩：记录写入、可控行为（写回调是否回流——健康/僵死连接两档）。
 * destroy 触发 close 事件（镜像真流生命周期——连接摘除走 close 面）。
 */
function fakeRes(opts: { healthy?: boolean } = {}): ServerResponse & { writes: string[]; destroyed: boolean } {
  const healthy = opts.healthy ?? true;
  const writes: string[] = [];
  const handlers = new Map<string, () => void>();
  let destroyed = false;
  const res = {
    writes,
    destroyed: false,
    write: (data: string, cb?: (err?: Error | null) => void) => {
      writes.push(data);
      // 健康连接：写回调异步回流（数据已交内核）；僵死连接：永不回流（写路径阻塞）
      if (cb !== undefined && healthy) queueMicrotask(() => cb());
      return true;
    },
    on: (event: string, fn: () => void) => {
      handlers.set(event, fn);
    },
    destroy: () => {
      if (destroyed) return; // 幂等（kill 幂等律的桩面镜像）
      destroyed = true;
      res.destroyed = true;
      handlers.get('close')?.();
    },
  };
  return res as unknown as ServerResponse & { writes: string[]; destroyed: boolean };
}

describe('WebuiChannel：连接帽与注册面', () => {
  it('逐条注册到帽（16）——第 17 条拒绝（undefined → 调用方 503）', () => {
    const channel = new WebuiChannel();
    for (let i = 0; i < WEBUI_MAX_CONNECTIONS; i++) {
      expect(channel.register(fakeRes())).toBeDefined();
    }
    expect(channel.size).toBe(WEBUI_MAX_CONNECTIONS);
    expect(channel.register(fakeRes())).toBeUndefined();
    channel.dispose();
  });

  it('客户端 close 事件即摘除（正常关流——无 watchdog 参与）', () => {
    const channel = new WebuiChannel();
    const res = fakeRes();
    channel.register(res);
    expect(channel.size).toBe(1);
    res.destroy(); // close 事件随 destroy 触发（桩面镜像）
    expect(channel.size).toBe(0);
    channel.dispose();
  });

  it('dispose 后 register 恒拒（closed 旗标）', () => {
    const channel = new WebuiChannel();
    channel.dispose();
    expect(channel.register(fakeRes())).toBeUndefined();
  });
});

describe('WebuiChannel：广播与三族 sink', () => {
  it('broadcast 扇出到全部在线连接（每帧单次 stringify 单行）', () => {
    const channel = new WebuiChannel();
    const a = fakeRes();
    const b = fakeRes();
    channel.register(a);
    channel.register(b);
    channel.broadcast({ kind: 'notify', payload: { message: 'hi' } });
    const expected = `data: ${JSON.stringify({ kind: 'notify', payload: { message: 'hi' } })}\n\n`;
    expect(a.writes).toEqual([expected]);
    expect(b.writes).toEqual([expected]);
    channel.dispose();
  });

  it('displaySink：信封 sessionId 上提 + payload = 事件本体（线格式）', () => {
    const channel = new WebuiChannel();
    const res = fakeRes();
    channel.register(res);
    channel.displaySink({ sessionId: 's1', event: { type: 'agent/message' } });
    expect(JSON.parse(res.writes[0]!.slice('data: '.length))).toEqual({
      kind: 'display',
      sessionId: 's1',
      payload: { type: 'agent/message' },
    });
    channel.dispose();
  });

  it('onSessionEvent：形状校验——坏载荷静默丢、合法载荷广播 kind:session', () => {
    const channel = new WebuiChannel();
    const res = fakeRes();
    channel.register(res);
    channel.onSessionEvent(undefined);
    channel.onSessionEvent('string');
    channel.onSessionEvent({ event: { type: 'x' } }); // 缺 sessionId
    expect(res.writes).toHaveLength(0);
    channel.onSessionEvent({ sessionId: 's2', event: { type: 'session/started' } });
    expect(JSON.parse(res.writes[0]!.slice('data: '.length))).toEqual({
      kind: 'session',
      sessionId: 's2',
      payload: { type: 'session/started' },
    });
    channel.dispose();
  });

  it('backend 能力面钉死：id/notify/setStatus 在场，confirm 等缺席；hasAudience 随连接数（#44）', () => {
    const channel = new WebuiChannel();
    expect(channel.backend.id).toBe('webui');
    expect(channel.backend.notify).toBeTypeOf('function');
    expect(channel.backend.setStatus).toBeTypeOf('function');
    expect('confirm' in channel.backend).toBe(false);
    expect('input' in channel.backend).toBe(false);
    expect('select' in channel.backend).toBe(false);
    // 观众探针（基建大扫 #44）：自报在线连接数——零连接 = 无观众（daemon webui
    // 常开零连接时 obs 告警不耗冷却；连接在线即有观众）
    expect(channel.backend.hasAudience).toBeTypeOf('function');
    expect(channel.backend.hasAudience!()).toBe(false);
    channel.register(fakeRes());
    expect(channel.backend.hasAudience!()).toBe(true);
    // notify 带 level 时并入载荷
    const res = fakeRes();
    channel.register(res);
    channel.backend.notify('warn!', { level: 'warn' });
    expect(JSON.parse(res.writes[0]!.slice('data: '.length))).toEqual({
      kind: 'notify',
      payload: { message: 'warn!', level: 'warn' },
    });
    channel.dispose();
  });

  it('dispose 后三 sink 全 no-op（addDisplay 无注销器的 closed 自守）', () => {
    const channel = new WebuiChannel();
    const res = fakeRes();
    channel.register(res);
    channel.dispose();
    const before = res.writes.length;
    channel.displaySink({ sessionId: 's', event: { type: 'x' } });
    channel.onSessionEvent({ sessionId: 's', event: { type: 'x' } });
    channel.backend.notify('n');
    channel.backend.setStatus('idle');
    expect(res.writes.length).toBe(before);
    expect(channel.size).toBe(0);
  });
});

describe('WebuiChannel：心跳看门狗（B1 写侧判死）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('健康连接：ping 写回调回流即清看门狗——90s 后仍存活', async () => {
    const channel = new WebuiChannel();
    const res = fakeRes({ healthy: true });
    channel.register(res);
    await vi.advanceTimersByTimeAsync(WEBUI_PING_INTERVAL_MS); // 首拍 ping
    await vi.advanceTimersByTimeAsync(WEBUI_WRITE_TIMEOUT_MS + 1000); // 回流已清钟
    expect(channel.size).toBe(1);
    expect(res.destroyed).toBe(false);
    channel.dispose();
  });

  it('僵死连接：写回调 90s 未回流 → 看门狗判死（reap + destroy）', async () => {
    const channel = new WebuiChannel();
    const dead = fakeRes({ healthy: false });
    const alive = fakeRes({ healthy: true });
    channel.register(dead);
    channel.register(alive);
    await vi.advanceTimersByTimeAsync(WEBUI_PING_INTERVAL_MS); // 首拍 ping（两连接各挂看门狗）
    await vi.advanceTimersByTimeAsync(WEBUI_WRITE_TIMEOUT_MS + 1000);
    expect(dead.destroyed).toBe(true);
    expect(alive.destroyed).toBe(false);
    expect(channel.size).toBe(1); // 僵死者已 reap，健康者在册
    channel.dispose();
  });

  it('dispose 清心跳节拍器——不再发新拍（无裸 timer 泄漏）', async () => {
    const channel = new WebuiChannel();
    const res = fakeRes({ healthy: true });
    channel.register(res);
    channel.dispose();
    const writesAtDispose = res.writes.length;
    await vi.advanceTimersByTimeAsync(WEBUI_PING_INTERVAL_MS * 3);
    expect(res.writes.length).toBe(writesAtDispose);
  });
});
