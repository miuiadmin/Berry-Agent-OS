/**
 * 敏感数据脱敏单元测试（§3.6 场景 E）。
 */
import { describe, it, expect } from 'vitest';
import { redactSensitiveData, redactJsonStrings, listRedactionTypes } from './sensitive-redactor.js';

describe('redactSensitiveData', () => {
  it('脱敏邮箱', () => {
    const r = redactSensitiveData('联系我 user@example.com 拿数据');
    expect(r.redacted).toBe('联系我 [REDACTED:email] 拿数据');
    expect(r.detectedTypes).toContain('email');
    expect(r.totalReplacements).toBe(1);
  });

  it('脱敏中国手机号', () => {
    const r = redactSensitiveData('电话 13812345678');
    expect(r.redacted).toBe('电话 [REDACTED:phone_cn]');
    expect(r.detectedTypes).toContain('phone_cn');
  });

  it('脱敏身份证号', () => {
    const r = redactSensitiveData('身份证 110101199003078813');
    expect(r.redacted).toBe('身份证 [REDACTED:id_card_cn]');
    expect(r.detectedTypes).toContain('id_card_cn');
  });

  it('脱敏 Bearer token', () => {
    const r = redactSensitiveData('Authorization: Bearer abc123def456ghi789jkl012mno');
    expect(r.redacted).toContain('[REDACTED:bearer_token]');
  });

  it('脱敏 AWS access key', () => {
    const r = redactSensitiveData('key = AKIAIOSFODNN7EXAMPLE');
    expect(r.redacted).toContain('[REDACTED:aws_access_key]');
  });

  it('脱敏 OpenAI style API key', () => {
    const r = redactSensitiveData('sk-abcdefghijklmnopqrstuvwxyz1234567890ABCD');
    expect(r.redacted).toContain('[REDACTED:api_key]');
  });

  it('脱敏 PEM 私钥块', () => {
    const pem = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ
-----END PRIVATE KEY-----`;
    const r = redactSensitiveData(`key: ${pem}`);
    expect(r.redacted).toContain('[REDACTED:private_key]');
    expect(r.redacted).not.toContain('MIIEvQIBADAN');
  });

  it('脱敏密码字段', () => {
    const r = redactSensitiveData('password=hunter2 other stuff');
    expect(r.redacted).toContain('[REDACTED:password]');
    expect(r.redacted).not.toContain('hunter2');
  });

  it('多个敏感类型一次脱敏', () => {
    const content = 'email: a@b.com phone: 13812345678 token: AKIAIOSFODNN7EXAMPLE';
    const r = redactSensitiveData(content);
    expect(r.detectedTypes.length).toBeGreaterThanOrEqual(3);
    expect(r.totalReplacements).toBeGreaterThanOrEqual(3);
  });

  it('无敏感数据返回原内容', () => {
    const content = 'this is a normal text without any sensitive info';
    const r = redactSensitiveData(content);
    expect(r.redacted).toBe(content);
    expect(r.totalReplacements).toBe(0);
  });

  it('空内容返回空', () => {
    expect(redactSensitiveData('').redacted).toBe('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(redactSensitiveData(null as any).redacted).toBe(null);
  });
});

describe('redactJsonStrings', () => {
  it('递归脱敏 JSON 对象的字符串字段', () => {
    const input = {
      user: 'alice@example.com',
      data: {
        token: 'AKIAIOSFODNN7EXAMPLE',
        nested: {
          pwd: 'password=secret123',
        },
      },
    };
    const result = redactJsonStrings(input) as Record<string, unknown>;
    expect(result.user).toBe('[REDACTED:email]');
    expect((result.data as Record<string, unknown>).token).toBe('[REDACTED:aws_access_key]');
    expect(((result.data as Record<string, unknown>).nested as Record<string, unknown>).pwd).toContain('[REDACTED:password]');
  });

  it('保留非字符串字段', () => {
    const input = { count: 42, active: true, items: [1, 2, 3] };
    expect(redactJsonStrings(input)).toEqual(input);
  });

  it('处理数组', () => {
    const input = ['safe', 'unsafe with AKIAIOSFODNN7EXAMPLE'];
    const result = redactJsonStrings(input) as string[];
    expect(result[0]).toBe('safe');
    expect(result[1]).toContain('[REDACTED:aws_access_key]');
  });
});

describe('listRedactionTypes', () => {
  it('返回至少 7 种类型', () => {
    const types = listRedactionTypes();
    expect(types.length).toBeGreaterThanOrEqual(7);
    expect(types).toContain('email');
    expect(types).toContain('phone_cn');
    expect(types).toContain('aws_access_key');
  });
});