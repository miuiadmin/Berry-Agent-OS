import { describe, it, expect } from 'vitest';
import { redactSensitiveData, redactJsonStrings } from './sensitive-redactor.js';
import { redactSecrets } from '../observability/redaction.js';

/**
 * sensitive-redactor 单测 —— 钉死 P1 单源化后的不变量：
 *   1. PGP 私钥块（带 BLOCK 后缀）被脱敏（历史双写漂移漏匹配，现复用 redaction.ts 单源已修）
 *   2. secret 检测与 redactSecrets 单源一致（sk-ant- 等两函数都命中）
 *   3. PII 仍独立覆盖（邮箱 / 手机——这些 redactSecrets 不管，只本模块管）
 */

const PGP_PRIVATE_KEY = `-----BEGIN PGP PRIVATE KEY BLOCK-----
mQENabc1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN
-----END PGP PRIVATE KEY BLOCK-----`;

const RSA_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAabcd1234xyz
-----END RSA PRIVATE KEY-----`;

describe('redactSensitiveData — PGP 漂移修复（P1 单源化）', () => {
  it('PGP 私钥块（带 BLOCK 后缀）被脱敏——历史敏感正则漏匹配，现复用 redaction.ts 单源已修', () => {
    const result = redactSensitiveData(`armor: ${PGP_PRIVATE_KEY}`);
    expect(result.redacted).toContain('[REDACTED:pem_private_key]');
    expect(result.redacted).not.toContain('mQENabc');
    expect(result.detectedTypes).toContain('pem_private_key');
  });

  it('RSA 私钥块仍被脱敏（回归保护）', () => {
    const result = redactSensitiveData(`key: ${RSA_PRIVATE_KEY}`);
    expect(result.redacted).toContain('[REDACTED:pem_private_key]');
    expect(result.redacted).not.toContain('MIIEpAIBAAKCAQEAabcd');
  });
});

describe('redactSensitiveData — secret 单源一致性（与 redactSecrets 对齐）', () => {
  it('anthropic key（sk-ant-）两函数都命中——单源化后不再分歧', () => {
    const content = '我的 key 是 sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx';
    const bySecrets = redactSecrets(content);
    const bySensitive = redactSensitiveData(content);
    expect(bySecrets).toContain('[REDACTED:anthropic_key]');
    expect(bySensitive.redacted).toContain('[REDACTED:anthropic_key]');
    // 两者 secret 部分输出一致（sensitive 可能额外含 PII，但 anthropic_key 占位符都在）
    expect(bySensitive.redacted).not.toContain('sk-ant-api03');
  });

  it('新增 api_key_other 前缀（gsk_ / xai-）被脱敏——单源化未丢覆盖', () => {
    const gsk = redactSensitiveData('groq key gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(gsk.redacted).toContain('[REDACTED:api_key_other]');
    expect(gsk.redacted).not.toContain('gsk_xxxxxxxx');
  });
});

describe('redactSensitiveData — PII 独立覆盖（redactSecrets 不管的）', () => {
  it('邮箱被脱敏（PII 仅本模块覆盖）', () => {
    const result = redactSensitiveData('联系我 user@example.com');
    expect(result.redacted).toContain('[REDACTED:email]');
    expect(result.redacted).not.toContain('user@example.com');
  });

  it('手机号被脱敏', () => {
    const result = redactSensitiveData('打 13800138000 给我');
    expect(result.redacted).toContain('[REDACTED:phone_cn]');
  });

  it('非敏感文本不变', () => {
    const result = redactSensitiveData('今天天气不错');
    expect(result.redacted).toBe('今天天气不错');
    expect(result.totalReplacements).toBe(0);
  });
});

describe('redactJsonStrings — 递归脱敏', () => {
  it('对象内字符串字段被脱敏（非字符串字段保留）', () => {
    const input = { user: 'ab', token: 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx', n: 42 };
    const out = redactJsonStrings(input);
    expect(out.token).toContain('[REDACTED:anthropic_key]');
    expect(out.user).toBe('ab');
    expect(out.n).toBe(42);
  });
});
