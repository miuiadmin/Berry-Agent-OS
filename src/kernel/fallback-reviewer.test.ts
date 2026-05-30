import { describe, it, expect } from 'vitest';
import { FallbackReviewer } from './fallback-reviewer.js';

describe('FallbackReviewer', () => {
  const reviewer = new FallbackReviewer();

  it('approves short plain text responses', () => {
    const result = reviewer.review({
      responseText: 'Hello! How can I help you today?',
      hasToolCalls: false,
      agentName: 'conversation',
    });
    expect(result.verdict).toBe('approve');
  });

  it('holds responses with tool calls', () => {
    const result = reviewer.review({
      responseText: 'Let me read that file for you.',
      hasToolCalls: true,
      toolNames: ['read_file'],
      agentName: 'code',
    });
    expect(result.verdict).toBe('hold');
  });

  it('holds responses with dangerous tools', () => {
    const result = reviewer.review({
      responseText: 'I will delete the file.',
      hasToolCalls: true,
      toolNames: ['delete_file'],
      agentName: 'code',
    });
    expect(result.verdict).toBe('hold');
    expect(result.reason).toContain('risky tools');
  });

  it('denies responses with dangerous patterns', () => {
    const result = reviewer.review({
      responseText: 'Running: rm -rf /tmp/project',
      hasToolCalls: false,
      agentName: 'code',
    });
    expect(result.verdict).toBe('deny');
  });

  it('denies SQL injection patterns', () => {
    const result = reviewer.review({
      responseText: 'DROP TABLE users;',
      hasToolCalls: false,
      agentName: 'conversation',
    });
    expect(result.verdict).toBe('deny');
  });

  it('holds large responses with code blocks', () => {
    const longCode = '```typescript\n' + 'const x = 1;\n'.repeat(50) + '```';
    const result = reviewer.review({
      responseText: longCode,
      hasToolCalls: false,
      agentName: 'code',
    });
    expect(result.verdict).toBe('hold');
  });

  it('holds short responses with code blocks (conservative)', () => {
    const result = reviewer.review({
      responseText: 'Here: ```const x = 1;```',
      hasToolCalls: false,
      agentName: 'conversation',
    });
    expect(result.verdict).toBe('hold');
  });
});
