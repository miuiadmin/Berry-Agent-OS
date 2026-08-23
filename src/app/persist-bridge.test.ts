/**
 * L5 app — pi-ai CredentialStore 适配器测试（真实 Store + :memory: 库）。
 *
 * 重点验两处语义翻译：modify 的「undefined = 不变」（pi-ai 侧）与
 * per-provider 串行（并发 modify 不交错）。
 */

import { describe, expect, it } from 'vitest';
import { Persistence } from '../persist/index.js';
import { createCredentialStore } from './persist-bridge.js';

/** api-key 凭证工厂 */
const apiKey = (key: string) => ({ type: 'api_key' as const, key });

describe('createCredentialStore', () => {
  it('read / modify / delete round-trip（data 原样承载 pi-ai Credential）', async () => {
    const persistence = Persistence.open({ path: ':memory:' });
    try {
      const store = createCredentialStore(persistence.store);
      await expect(store.read('anthropic')).resolves.toBeUndefined();

      const written = await store.modify('anthropic', async () => apiKey('sk-test'));
      expect(written).toEqual(apiKey('sk-test'));
      await expect(store.read('anthropic')).resolves.toEqual(apiKey('sk-test'));

      await store.delete('anthropic');
      await expect(store.read('anthropic')).resolves.toBeUndefined();
    } finally {
      await persistence.close();
    }
  });

  it('modify 的 fn 返回 undefined = 保持不变（pi-ai 语义，非删除）', async () => {
    const persistence = Persistence.open({ path: ':memory:' });
    try {
      const store = createCredentialStore(persistence.store);
      await store.modify('openai', async () => apiKey('sk-keep'));
      const result = await store.modify('openai', async (current) => {
        expect(current).toEqual(apiKey('sk-keep')); // fn 收到当前值
        return undefined; // pi-ai 语义：不变
      });
      expect(result).toEqual(apiKey('sk-keep'));
      await expect(store.read('openai')).resolves.toEqual(apiKey('sk-keep'));
    } finally {
      await persistence.close();
    }
  });

  it('list 只给元数据不给密钥；oauth 凭证 kind 列同步', async () => {
    const persistence = Persistence.open({ path: ':memory:' });
    try {
      const store = createCredentialStore(persistence.store);
      await store.modify('anthropic', async () => apiKey('sk-secret'));
      await store.modify('some-oauth', async () => ({
        type: 'oauth' as const,
        refresh: 'r',
        access: 'a',
        expires: 1,
      }));
      const listed = await store.list();
      expect(listed).toEqual([
        { providerId: 'anthropic', type: 'api_key' },
        { providerId: 'some-oauth', type: 'oauth' },
      ]);
      // 密钥不在 list 产物里（只读了元数据列）
      expect(JSON.stringify(listed)).not.toContain('sk-secret');
    } finally {
      await persistence.close();
    }
  });

  it('同 provider 并发 modify 串行（后写基于前写结果，不交错）', async () => {
    const persistence = Persistence.open({ path: ':memory:' });
    try {
      const store = createCredentialStore(persistence.store);
      // 两路并发：记录各自 fn 收到的当前值——串行链按调用序排队，
      // 第二路必然看到第一路写入的结果（而非 undefined）
      const seen: Array<string | undefined> = [];
      await Promise.all([
        store.modify('counter', async (current) => {
          seen.push((current as { key?: string } | undefined)?.key);
          return apiKey('one');
        }),
        store.modify('counter', async (current) => {
          seen.push((current as { key?: string } | undefined)?.key);
          return apiKey('two');
        }),
      ]);
      expect(seen).toEqual([undefined, 'one']); // 第二路基于第一路的结果
      await expect(store.read('counter')).resolves.toEqual(apiKey('two'));
    } finally {
      await persistence.close();
    }
  });
});
