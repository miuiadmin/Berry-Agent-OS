/**
 * L1 persist 单元测试（Persistence 门面）——onLiveEvent 活体镜像三路接线。
 *
 * session/event 活体事件的 persist 半边（契约篇 §2.2）：createSession /
 * forkSession / loadSession 三条建会话路径注入的 emit 回调统一经 sink
 * （write-behind 入队 → 镜像回调）。本文件锁：三路 append 都回调且信封
 * 正确、durable 落库不受镜像影响、不传选项行为不变。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Persistence } from './index.js';

/** 临时库目录（全文件共享，结束后整体清除） */
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'persist-facade-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('onLiveEvent 活体镜像（三路接线）', () => {
  it('create/fork：append 即回调（sessionId + 事件信封），durable 落库不受影响', async () => {
    const seen: Array<{ sessionId: string; type: string; seq: number }> = [];
    const p = Persistence.open({
      path: join(dir, 'live.db'),
      onLiveEvent: (sessionId, event) => seen.push({ sessionId, type: event.type, seq: event.seq }),
    });

    const parent = p.createSession({ cwd: '/w' });
    parent.append('turn/start', {});
    parent.append('turn/end', { reason: 'completed' }); // fork 边界须落在 turn 闭合之后
    const child = p.forkSession(parent);
    child.append('turn/start', {});
    await p.flush();

    // 镜像信封：父子各自 sessionId 归属可分辨（dsh-11——多会话并存的判据），
    // seq 与事件本体一致（子会话种子 3 条：start/end/end-seed，新事件 seq=3；
    // end-seed 经字面量构造进子种子，不经父 append——父镜像无此事件）
    expect(seen).toEqual([
      { sessionId: parent.header.sessionId, type: 'turn/start', seq: 0 },
      { sessionId: parent.header.sessionId, type: 'turn/end', seq: 1 },
      { sessionId: child.header.sessionId, type: 'turn/start', seq: 3 },
    ]);
    // durable 不受镜像影响：flush 后父子各自落齐（子含种子物理复制）
    expect(p.store.loadEvents(parent.header.sessionId)).toHaveLength(2);
    expect(p.store.loadEvents(child.header.sessionId)).toHaveLength(4);
    await p.close();
  });

  it('load 恢复路同接线：重开会话后续 append 也上镜像', async () => {
    const path = join(dir, 'live-reload.db');
    const p = Persistence.open({ path });
    const seedSession = p.createSession();
    seedSession.append('turn/start', {});
    await p.flush();
    await p.close();

    const seen: Array<{ sessionId: string; type: string }> = [];
    const reopened = Persistence.open({
      path,
      onLiveEvent: (sessionId, event) => seen.push({ sessionId, type: event.type }),
    });
    const restored = reopened.loadSession(seedSession.header.sessionId)!;
    expect(restored).toBeDefined();
    restored.append('turn/end', { reason: 'completed' });
    expect(seen).toEqual([{ sessionId: seedSession.header.sessionId, type: 'turn/end' }]);
    await reopened.close();
  });

  it('不传 onLiveEvent：缺省不接线，行为与既有完全一致', async () => {
    const p = Persistence.open({ path: join(dir, 'silent.db') });
    const session = p.createSession();
    expect(() => session.append('turn/start', {})).not.toThrow();
    await p.flush();
    expect(p.store.loadEvents(session.header.sessionId)).toHaveLength(1);
    await p.close();
  });
});
