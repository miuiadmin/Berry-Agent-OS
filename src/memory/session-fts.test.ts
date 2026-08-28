/**
 * L3 memory 集成测试（跨会话全文检索投影 session_fts）——经统一迁移框架建表后
 * 真库全栈（:memory: SQLite，无 mock）：增量索引 / 遮蔽区间删除 / 水位前进 /
 * 激活期对账（空索引重建 + 有水位补差 + 缺水位整卷重放）/ 检索转义与过滤。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../persist/index.js';
import { SESSION_FTS_MIGRATION, SessionFtsIndex, type SessionFtsSource } from './index.js';
import type { SessionEvent } from '../contracts/events.js';

/** 当前测试库（每用例新建 :memory:——迁移框架一次到位后交 DAO） */
let store: Store;
let fts: SessionFtsIndex;

beforeEach(() => {
  store = openStore({ path: ':memory:', migrations: [SESSION_FTS_MIGRATION] });
  fts = new SessionFtsIndex(store.connection);
});

/** 最小事件构造（durable 信封可索引面只读 type/seq/data/surfaceOp） */
function ev(
  seq: number,
  type: string,
  data: unknown,
  /** 遮蔽区间（SurfaceOp 唯一形态 op:'replace'——compaction 重投的改历史形态） */
  surfaceOp?: { start: number; end: number },
): SessionEvent {
  return {
    type,
    seq,
    time: 1,
    data,
    ...(surfaceOp !== undefined ? { surfaceOp: { op: 'replace', ...surfaceOp } } : {}),
  };
}

/** user 消息事件（content 纯字符串形态） */
const userEv = (seq: number, text: string): SessionEvent => ev(seq, 'user/message', { content: text });

/** assistant 消息事件（content 块数组形态——只取 text 块，thinking 不进） */
const assistantEv = (seq: number, text: string): SessionEvent =>
  ev(seq, 'assistant/message', {
    content: [
      { type: 'thinking', text: '模型独白不进索引' },
      { type: 'text', text },
    ],
  });

/** 读源替身：内存事件日志（对账面就是纯读——数据源形态与 Store 同构即真） */
function sourceOf(logs: Record<string, SessionEvent[]>): SessionFtsSource {
  return {
    listSessionIds: () => Object.keys(logs),
    loadEvents: (id) => logs[id] ?? [],
  };
}

describe('indexEvent 运行期增量', () => {
  it('user/assistant 文本进索引、tool 载荷不进；thinking 块不进、text 块进', () => {
    fts.indexEvent('s1', userEv(0, '用户偏好 pnpm 作为包管理器'));
    fts.indexEvent('s1', assistantEv(1, '好的，本项目统一用 pnpm'));
    fts.indexEvent('s1', ev(2, 'tool/call', { name: 'read', arguments: { path: 'x' } }));
    fts.indexEvent('s1', ev(3, 'request/header', { reason: 'initial' }));

    const hits = fts.search('pnpm');
    expect(hits).toHaveLength(2); // user + assistant 各一；tool/header 无行
    // FTS5 rank 是 BM25 相关度非插入序——只断集合不断序
    expect(hits.map((h) => h.seq).sort((a, b) => a - b)).toEqual([0, 1]);
    // 命中行带定位（sessionId + seq——跳转回放的锚点）
    expect(hits.every((h) => h.sessionId === 's1')).toBe(true);
    // thinking 文本没进索引（有命中也不该命中独白）
    expect(fts.search('模型独白')).toHaveLength(0);
  });

  it('水位无论是否产出行都前进（对账补差以「已处理」为准）', () => {
    fts.indexEvent('s1', ev(0, 'sandbox/mode', { mode: ' confined' })); // 无文本行
    fts.indexEvent('s1', userEv(1, 'hello world'));
    const state = store.connection.prepare(`SELECT seq FROM session_fts_state WHERE session_id = 's1'`).get() as {
      seq: number;
    };
    expect(state.seq).toBe(1); // 最后处理事件的水位（含无产出事件）
  });

  it('遮蔽事件：先删被遮蔽区间已索引行、改写事件本身作为新内容进索引', () => {
    fts.indexEvent('s1', userEv(0, '旧问题 alpha'));
    fts.indexEvent('s1', assistantEv(1, '旧回答 bravo'));
    fts.indexEvent('s1', userEv(2, '新问题 charlie'));
    // 遮蔽 [0,1]（如 compaction 重投——改历史的唯一合法形态）
    fts.indexEvent('s1', ev(3, 'user/message', { content: '摘要重投 delta' }, { start: 0, end: 1 }));

    expect(fts.search('alpha')).toHaveLength(0); // 被遮蔽行已删
    expect(fts.search('bravo')).toHaveLength(0);
    expect(fts.search('charlie')).toHaveLength(1); // 遮蔽区间外不动
    expect(fts.search('delta')).toHaveLength(1); // 改写事件本身进索引
    expect(fts.search('delta')[0]!.seq).toBe(3);
  });
});

describe('synchronize 激活期对账', () => {
  it('空索引全量重建：逐会话整卷重放（清残留水位防半态）', () => {
    // 半态前置：残留水位指向 s1 seq 9（但索引行已被清——模拟历史半装）
    store.connection.prepare(`INSERT INTO session_fts_state (session_id, seq) VALUES ('s1', 9)`).run();
    const logs = {
      s1: [userEv(0, '部署用 vercel'), assistantEv(1, '好的 vercel')],
      s2: [userEv(0, '另一个会话讲 netlify')],
    };
    fts.synchronize(sourceOf(logs));

    expect(fts.search('vercel')).toHaveLength(2); // 残留水位没拦住重建
    expect(fts.search('netlify')).toHaveLength(1);
  });

  it('有水位按会话补差：只重放 seq > 水位（增量不重复）', () => {
    const logs = { s1: [userEv(0, '第一段 foxtrot'), userEv(1, '第二段 golf')] };
    fts.synchronize(sourceOf(logs)); // 首次对账 → 全量
    // 日志增长（应用禁用期间不存在的下一段——重激活只补差）
    const grown = { s1: [...logs.s1!, userEv(2, '第三段 hotel')] };
    fts.synchronize(sourceOf(grown));

    expect(fts.search('foxtrot')).toHaveLength(1); // 不重复插入
    expect(fts.search('hotel')).toHaveLength(1); // 补差到位
  });

  it('缺水位的会话整卷重放（应用禁用期间新建的会话不漏）', () => {
    // s1 已有水位；s2 从未进索引（禁用期间新建）
    fts.indexEvent('s1', userEv(0, '老会话 india'));
    const logs = {
      s1: [userEv(0, '老会话 india')],
      s2: [userEv(0, '新会话 juliet'), userEv(1, '新会话 kilo')],
    };
    fts.synchronize(sourceOf(logs));

    expect(fts.search('india')).toHaveLength(1); // 水位在——不重放
    expect(fts.search('juliet')).toHaveLength(1); // 无水位——整卷重放补齐
    expect(fts.search('kilo')).toHaveLength(1);
  });
});

describe('search 检索面', () => {
  beforeEach(() => {
    fts.indexEvent('s1', userEv(0, '用户偏好 pnpm 作为包管理器'));
    fts.indexEvent('s2', userEv(0, '另一个项目用 yarn'));
    fts.indexEvent('s2', assistantEv(1, '明白，改用 yarn 安装'));
  });

  it('一个索引两用：跨会话（缺省）与会话内（sessionId 过滤）', () => {
    expect(fts.search('pnpm').map((h) => h.sessionId)).toEqual(['s1']);
    expect(
      fts
        .search('yarn')
        .map((h) => h.sessionId)
        .sort(),
    ).toEqual(['s2', 's2']);
    expect(fts.search('yarn', { sessionId: 's2' })).toHaveLength(2);
    expect(fts.search('yarn', { sessionId: 's1' })).toHaveLength(0);
  });

  it('查询转义：多 token 隐式 AND、引号不炸 MATCH、空 token 不命中', () => {
    expect(fts.search('pnpm 包管理器')).toHaveLength(1); // 两 token 都要在
    expect(fts.search('pnpm 不存在的词')).toHaveLength(0);
    expect(fts.search('"pnpm"')).toHaveLength(1); // 用户带引号不炸语法（转义后命中）
    expect(fts.search('!!!')).toHaveLength(0); // 无字母数字 token → 空
    expect(fts.search('')).toHaveLength(0);
  });

  it('trigram 子串语义：短 token 命中含它的长词（中英混排选型的本义）', () => {
    // 'npm' 是 'pnpm' 的子串——trigram 按字符三元组匹配，天然子串命中
    expect(fts.search('npm').map((h) => h.sessionId)).toEqual(['s1']);
    expect(fts.search('包管理器')).toHaveLength(1); // 中文子串同路
  });

  it('limit 生效 + snippet 带命中词', () => {
    const limited = fts.search('yarn', { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.snippet).toContain('yarn'); // snippet 凸显命中词
  });
});
