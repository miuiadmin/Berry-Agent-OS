/**
 * L5 app — pi-ai CredentialStore ← persist store 适配器（骨架篇 §5.1 L4：两 Store
 * 的 SQLite 实现归 persist，app 组合根适配后注入 llm 运行时）。
 *
 * 两处语义差异在此显式翻译：
 * ① modify 的「不变」语义——pi-ai 的 fn 返回 undefined = 保持条目不变（删除走
 *   delete）；persist 的 mutator 返回 undefined = 删除。适配器预计算后定向写入；
 * ② 串行化——pi-ai 契约「modify 是唯一写路径且 per-provider 串行」，persist 的
 *   modifyCredential 是同步事务（天然原子），但适配器自己要先读当前值再调 fn
 *   （fn 可能含网络刷新），读与写之间必须由 per-provider promise 链串行防双刷新。
 *
 * ModelsStore 适配 M1 跳过：Anthropic 静态目录已覆盖缺省面，动态目录刷新
 * （refresh）随真实多 provider 需求再接（未覆盖≠驳回）。
 */

import type { Store } from '../persist/store.js';
import type { Credential, CredentialInfo, CredentialStore } from '../llm/index.js';

/** pi-ai 凭证类别（data.type 字段的镜像——persist kind 列的写入依据） */
function credentialKind(credential: Credential): string {
  return credential.type === 'oauth' ? 'oauth' : 'api-key';
}

/**
 * 把 persist store 适配成 pi-ai CredentialStore（app 组合根注入 llm 运行时用）。
 * @param store persist 物理层（凭证表的唯一承载）
 */
export function createCredentialStore(store: Store): CredentialStore {
  /** per-provider 串行链（modify/delete 共用——delete 契约要求与 modify 互斥） */
  const locks = new Map<string, Promise<unknown>>();

  /** 把异步任务排进 provider 的串行链；前序失败不阻断后续（锁只防并发不传播错误） */
  const serialize = <T>(providerId: string, task: () => Promise<T>): Promise<T> => {
    const previous = locks.get(providerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    locks.set(providerId, next);
    return next;
  };

  return {
    async read(providerId) {
      const row = store.getCredential(providerId);
      // persist 的 data 即 pi-ai Credential 原样（type 标签随对象存储）
      return row ? (row.data as Credential) : undefined;
    },

    async list() {
      // 元数据枚举不暴露 data（pi-ai list 契约）；kind 列与 data.type 同步写
      return store.listCredentialEntries().map((entry): CredentialInfo => ({
        providerId: entry.provider,
        type: entry.kind === 'oauth' ? 'oauth' : 'api_key',
      }));
    },

    modify: (providerId, fn) =>
      serialize(providerId, async () => {
        // 串行链内读当前值 → 调 fn（可能网络刷新）→ 定向写入（预计算后无竞态）
        const current = store.getCredential(providerId)?.data as Credential | undefined;
        const next = await fn(current);
        if (next === undefined) return current; // pi-ai 语义：undefined = 保持不变
        store.modifyCredential(providerId, () => next, { kind: credentialKind(next) });
        return next;
      }),

    delete: (providerId) =>
      serialize(providerId, async () => {
        store.modifyCredential(providerId, () => undefined);
      }),
  };
}
