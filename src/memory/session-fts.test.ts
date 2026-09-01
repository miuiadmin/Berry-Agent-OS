/**
 * L3 memory 集成测试（跨会话全文检索投影 session_fts）——经统一迁移框架建表后
 * 真库全栈（:memory: SQLite，无 mock）：增量索引 / 遮蔽区间删除 / 水位前进 /
 * 激活期对账（空索引重建 + 有水位补差 + 缺水位整卷重放）/ 检索转义与过滤。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../persist/index.js';
import {
  SESSION_FTS_MIGRATION,
  SESSION_FTS_VERIFY_MIGRATION,
  SessionFtsIndex,
  type SessionFtsSource,
} from './index.js';
import type { SessionEvent } from '../contracts/events.js';

/** 当前测试库（每用例新建 :memory:——迁移框架一次到位后交 DAO） */
let store: Store;
let fts: SessionFtsIndex;

beforeEach(() => {
  store = openStore({ path: ':memory:', migrations: [SESSION_FTS_MIGRATION, SESSION_FTS_VERIFY_MIGRATION] });
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
    countEvents: (id) => (logs[id] ?? []).length,
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

describe('复盘 20260901 D-1/D-2 回归锁（种子段核验修复 + 单事件原子性）', () => {
  it('D-1 fork 种子段修复：活体水位越过未索引种子段——对账核验实有≠期望 → 清行整卷重放', () => {
    // fork/委派子会话形状：种子 [0,1] 物理在库（write-behind 首队复制）但结构性
    // 不上活体总线（历史不重播）；首条活体事件 seq=2 直接把水位推过种子段
    const childLog = [userEv(0, '种子首段 sierra'), userEv(1, '种子次段 tango'), userEv(2, '活体内容 uniform')];
    fts.indexEvent('child', childLog[2]!); // 活体镜像只见到 seq=2——水位即 2
    // HEAD：补差按「seq <= 水位跳过」——种子段永不进索引（跨会话 union 命中父会话
    // 副本，子会话身份的会话内检索结构性缺段）；修复后：行集核验 1≠3 → 整卷重建
    fts.synchronize(sourceOf({ child: childLog }));
    expect(fts.search('sierra', { sessionId: 'child' })).toHaveLength(1);
    expect(fts.search('tango', { sessionId: 'child' })).toHaveLength(1);
    expect(fts.search('uniform', { sessionId: 'child' })).toHaveLength(1); // 重放不双计
  });

  it('D-2 崩溃半态自愈：行在水位缺（三语句半态残留）——对账清行重建不双计', () => {
    // 模拟 D-2 崩溃窗残留：正文行已提交、水位没跟上（裸 SQL 直插绕过 indexEvent——
    // 三语句非原子时代的中间态）
    store.connection.prepare(`INSERT INTO session_fts (session_id, seq, body) VALUES ('s1', 0, '孤儿行 voodoo')`).run();
    const logs = { s1: [userEv(0, '孤儿行 voodoo')] };
    // HEAD：缺水位路径整卷重放但不清行 → 双行；修复后：清行先行 → 恰一行
    fts.synchronize(sourceOf(logs));
    expect(fts.search('voodoo')).toHaveLength(1);
  });

  it('D-2 单事件原子性：三语句中途炸 → 全回滚（遮蔽删除不残留半态）', () => {
    fts.indexEvent('s1', userEv(0, '旧内容 whiskey'));
    fts.indexEvent('s1', userEv(1, '旧内容 xray'));
    // 故障注入：连接面包一层——正文 INSERT 语句抛错（中间语句炸 = 崩溃窗的受控形态）
    const real = store.connection;
    const boomDb = {
      prepare: (sql: string) =>
        sql.startsWith('INSERT INTO session_fts (')
          ? {
              run: () => {
                throw new Error('注入：正文插入炸');
              },
            }
          : real.prepare(sql),
      transaction: (fn: (...args: never[]) => unknown) => real.transaction(fn),
    } as unknown as typeof real;
    const ftsBoom = new SessionFtsIndex(boomDb);
    // 遮蔽载体事件：先删被遮蔽区间 [0,1]，随后正文插入炸
    expect(() =>
      ftsBoom.indexEvent('s1', ev(2, 'user/message', { content: '摘要 yankee' }, { start: 0, end: 1 })),
    ).toThrow(/注入/);
    // HEAD：三语句各自自动提交——删除已落库成半态；修复后：单事务全回滚
    expect(fts.search('whiskey')).toHaveLength(1);
    expect(fts.search('xray')).toHaveLength(1);
  });

  it('核验判据不误伤：活体全程索引的会话（含遮蔽）对账零重建零复活（green 锁）', () => {
    const log = [
      userEv(0, '首段 zulu'),
      assistantEv(1, '回应 alpha2'),
      userEv(2, '中间 bravo2'),
      // 遮蔽 [1,2]（compaction 重投形态——折算必须同构建模遮蔽，否则误判重建复活死行）
      ev(3, 'user/message', { content: '摘要重投 charlie2' }, { start: 1, end: 2 }),
      userEv(4, '尾段 delta2'),
    ];
    for (const e of log) fts.indexEvent('s1', e);
    fts.synchronize(sourceOf({ s1: log })); // 重激活对账——折算期望 == 实有 → 纯补差零重建
    expect(fts.search('zulu')).toHaveLength(1);
    expect(fts.search('alpha2')).toHaveLength(0); // 遮蔽保持（核验误判会经重建复活死行）
    expect(fts.search('bravo2')).toHaveLength(0);
    expect(fts.search('charlie2')).toHaveLength(1);
    expect(fts.search('delta2')).toHaveLength(1);
  });
});

describe('遗漏大扫 20260901 O-8/L-8（对账成本三档 + 零语句事件免事务）', () => {
  /** 计数读源：loadEvents 次数 = 预检豁免判据的可观察面（豁免 = 零全量读） */
  function countedSource(logs: Record<string, SessionEvent[]>, counter: { loads: number }): SessionFtsSource {
    return {
      listSessionIds: () => Object.keys(logs),
      loadEvents: (id) => {
        counter.loads++;
        return logs[id] ?? [];
      },
      countEvents: (id) => (logs[id] ?? []).length,
    };
  }

  it('O-8 通过标记：事件总数未变的对账整会话豁免（零 loadEvents 读）——修复前必红（旧码每次装载全量读）', () => {
    const logs = { s1: [userEv(0, '首段 lima'), userEv(1, '次段 mike')] };
    fts.synchronize(countedSource(logs, { loads: 0 })); // 首次对账（空索引重建 + 落标记）
    const counter = { loads: 0 };
    fts.synchronize(countedSource(logs, counter)); // 稳态：boot//reload 重装载
    expect(counter.loads).toBe(0); // 稳态对账零全量读——成本不随库内总事件数线性涨
    expect(fts.search('lima')).toHaveLength(1); // 索引原样在场
    expect(fts.search('mike')).toHaveLength(1);
  });

  it('O-8 豁免只认未变：事件增长会话重入对账（核验 + 补差照常）', () => {
    const logs = { s1: [userEv(0, '首段 november')] };
    fts.synchronize(countedSource(logs, { loads: 0 }));
    const grown = { s1: [...logs.s1!, userEv(1, '新段 oscar')] };
    const counter = { loads: 0 };
    fts.synchronize(countedSource(grown, counter));
    expect(counter.loads).toBe(1); // 有变化 → 全量读重入
    expect(fts.search('oscar')).toHaveLength(1); // 补差到位
    expect(fts.search('november')).toHaveLength(1); // 不双计
  });

  it('L-8 零语句事件免事务：无遮蔽无文本事件不落任何写（水位零残留）——修复前必红（旧码每事件一事务一 fsync）', () => {
    fts.indexEvent('s1', ev(0, 'sandbox/mode', { mode: 'workspace-write' }));
    fts.indexEvent('s1', ev(1, 'tool/call', { toolCallId: 't', name: 'x', arguments: '{}' }));
    const row = store.connection.prepare(`SELECT seq FROM session_fts_state WHERE session_id = 's1'`).get();
    expect(row).toBeUndefined(); // 零语句 = 零落库（免事务免 fsync）
    // 后继文本事件 MAX 语义追平——水位滞后不累积
    fts.indexEvent('s1', userEv(2, '追平 papa'));
    const after = store.connection.prepare(`SELECT seq FROM session_fts_state WHERE session_id = 's1'`).get() as {
      seq: number;
    };
    expect(after.seq).toBe(2);
  });

  it('零语句段水位滞后不误判：行集核验判据与滞后正交（green 锁）', () => {
    const log = [
      ev(0, 'turn/start', {}), // 零语句——水位不前进
      userEv(1, '内容 quebec'), // 文本——水位 1
      ev(2, 'turn/end', { reason: 'completed' }), // 零语句——水位停 1
    ];
    fts.indexEvent('s1', log[0]!);
    fts.indexEvent('s1', log[1]!);
    fts.indexEvent('s1', log[2]!);
    fts.synchronize(countedSource({ s1: log }, { loads: 0 })); // 核验须通过——零重建
    expect(fts.search('quebec')).toHaveLength(1);
  });
});
