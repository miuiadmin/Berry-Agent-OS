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

describe('应用域打标（契约篇 §5.4 第二纵切——sessions.app 列 v6）', () => {
  it('createSession 打标 round-trip：sessions 行落 app，重开库 loadSession 元数据不丢', async () => {
    const path = join(dir, 'app-tag.db');
    const p = Persistence.open({ path });
    const hers = p.createSession({ cwd: '/w/hermes', app: 'hermes' });
    const bare = p.createSession({ cwd: '/w/bare' }); // 不打标 = NULL（存量/未声明域）
    hers.append('turn/start', {});
    hers.append('turn/end', { reason: 'completed' }); // fork 边界须落在 turn 闭合之后
    bare.append('turn/start', {});
    await p.flush();
    // 物理行：打标落列、不打标 NULL（不回填——NULL 域语义保留）
    expect(p.store.sessionRow(hers.header.sessionId)!.app).toBe('hermes');
    expect(p.store.sessionRow(bare.header.sessionId)!.app).toBeNull();
    await p.close();

    // 重开库：loadSession 恢复元数据（fork 继承要靠它）
    const p2 = Persistence.open({ path });
    const resumed = p2.loadSession(hers.header.sessionId)!;
    resumed.append('turn/start', {});
    resumed.append('turn/end', { reason: 'completed' });
    await p2.flush();
    const forked = p2.forkSession(resumed); // fork 缺省继承父域
    forked.append('turn/start', {});
    await p2.flush();
    expect(p2.store.sessionRow(forked.header.sessionId)!.app).toBe('hermes');
    await p2.close();
  });

  it('latestSessionId 域两形：chat 域含 NULL 存量（不弃养），严格域只认本域', async () => {
    const p = Persistence.open({ path: join(dir, 'app-domain.db') });
    // 同 cwd 三个会话：NULL 存量（旧）、chat、hermes——创建序即 created_at 序
    const legacy = p.createSession({ cwd: '/w' });
    const chat = p.createSession({ cwd: '/w', app: 'chat' });
    const hers = p.createSession({ cwd: '/w', app: 'hermes' });
    for (const s of [legacy, chat, hers]) s.append('turn/start', {});
    await p.flush();

    // chat 域含 NULL：最新是 hermes（后建）但不在域内 → 域内最新 = chat
    expect(p.latestSessionId('/w', { app: 'chat', includeNullApp: true })).toBe(chat.header.sessionId);
    // 严格域（第三方）：只认本域，不吞 NULL 也不吞他域
    expect(p.latestSessionId('/w', { app: 'hermes' })).toBe(hers.header.sessionId);
    // 无域 = 全域原行为（TUI 续接兜底）
    expect(p.latestSessionId('/w')).toBe(hers.header.sessionId);
    await p.close();
  });
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
