import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpFetchTool } from './web.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('httpFetchTool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns status line and body on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('hello world'),
    });

    const result = await httpFetchTool.execute({ url: 'http://example.com', method: 'GET' });
    expect(result.content).toContain('HTTP 200 OK');
    expect(result.content).toContain('hello world');
    expect(result.isError).toBeFalsy();
  });

  it('marks non-2xx as error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('page missing'),
    });

    const result = await httpFetchTool.execute({ url: 'http://example.com/x' });
    expect(result.content).toContain('HTTP 404');
    expect(result.isError).toBe(true);
  });

  it('truncates response body exceeding 20KB', async () => {
    const largeBody = 'x'.repeat(25000);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(largeBody),
    });

    const result = await httpFetchTool.execute({ url: 'http://example.com/big' });
    expect(result.content).toContain('响应被截断');
    expect(result.content!.length).toBeLessThan(25000);
  });

  it('returns timeout message on AbortError', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValue(abortError);

    const result = await httpFetchTool.execute({ url: 'http://example.com/slow' });
    expect(result.content).toContain('超时');
    expect(result.isError).toBe(true);
  });

  it('returns error message on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await httpFetchTool.execute({ url: 'http://example.com/down' });
    expect(result.content).toContain('ECONNREFUSED');
    expect(result.isError).toBe(true);
  });

  it('passes method, headers, and body to fetch', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('ok'),
    });

    await httpFetchTool.execute({
      url: 'http://api.example.com',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"key":"value"}',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://api.example.com',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"key":"value"}',
      }),
    );
  });
});
