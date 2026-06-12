import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redaction.js';

/**
 * 15.0 存储层加固：对话内容子串级 secret 清洗的单元测试。
 *
 * 验证 redactSecrets 能识别内嵌在自然语言中的各类 secret，
 * 替换为 [REDACTED:name] 占位符，且不破坏正常文本。
 */
describe('redactSecrets (15.0 对话内容子串清洗)', () => {
  it('替换内嵌的 anthropic key，保留正文', () => {
    const input = '我的 API key 是 sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
    const out = redactSecrets(input);
    expect(out).toBe('我的 API key 是 [REDACTED:anthropic_key]');
    expect(out).not.toContain('sk-ant-api03');
  });

  it('sk-ant- 不被 openai 的 sk- 正则吞掉（顺序正确）', () => {
    const out = redactSecrets('key: sk-ant-test1234567890123456');
    expect(out).toContain('[REDACTED:anthropic_key]');
    expect(out).not.toMatch(/sk-ant/);
  });

  it('替换 openai key（sk- 非 ant 前缀）', () => {
    const out = redactSecrets('token: sk-proj1234567890abcdefghij');
    expect(out).toContain('[REDACTED:openai_key]');
  });

  it('替换 github PAT', () => {
    const out = redactSecrets('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    expect(out).toContain('[REDACTED:github_pat]');
  });

  it('替换 AWS access key', () => {
    const out = redactSecrets('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED:aws_key]');
  });

  it('替换 Bearer token', () => {
    const out = redactSecrets('Authorization: Bearer abcdef1234567890xyz');
    expect(out).toContain('[REDACTED:bearer_token]');
    expect(out).not.toContain('abcdef1234567890xyz');
  });

  it('替换长 hex（疑似私钥，40+ 位）', () => {
    const hex = 'a'.repeat(48);
    const out = redactSecrets(`private: ${hex}`);
    expect(out).toContain('[REDACTED:long_hex]');
  });

  it('不破坏正常中文/英文/价格对话', () => {
    const input = '今天天气不错，the weather is fine, 价格 $100';
    expect(redactSecrets(input)).toBe(input);
  });

  it('不误伤短 hex（< 40 位）', () => {
    // 32 位 hex 是常见的 hash/uuid 片段，不应被当私钥替换
    const input = 'commit sha: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    expect(redactSecrets(input)).toBe(input);
  });

  it('空输入原样返回', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets(undefined as unknown as string)).toBeUndefined();
  });

  it('多 secret 同时存在全部替换', () => {
    const input = 'a=sk-ant-abcdefghijklmnopqrstuvwx b=ghp_1234567890abcdefghijklmnopqrstuvwxyz';
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED:anthropic_key]');
    expect(out).toContain('[REDACTED:github_pat]');
  });

  it('幂等：对已清洗结果再次清洗不产生变化', () => {
    const input = 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
    const once = redactSecrets(input);
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });
});
