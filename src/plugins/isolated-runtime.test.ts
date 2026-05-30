import { describe, it, expect } from 'vitest';
import { IsolatedPluginExecutor } from './isolated-runtime.js';

describe('IsolatedPluginExecutor — fs isolation', () => {
  it('rejects relative entry paths', () => {
    const executor = new IsolatedPluginExecutor({});
    expect(() =>
      (executor as unknown as { validateEntryPath(p: string, n: string): void })
        .validateEntryPath('relative/path.js', 'test-plugin'),
    ).toThrow('绝对路径');
  });

  it('rejects entry paths outside pluginsDir', () => {
    const executor = new IsolatedPluginExecutor({ pluginsDir: '/safe/plugins' });
    expect(() =>
      (executor as unknown as { validateEntryPath(p: string, n: string): void })
        .validateEntryPath('/etc/malicious.js', 'evil-plugin'),
    ).toThrow('越界');
  });

  it('allows entry paths inside pluginsDir', () => {
    const executor = new IsolatedPluginExecutor({ pluginsDir: '/safe/plugins' });
    expect(() =>
      (executor as unknown as { validateEntryPath(p: string, n: string): void })
        .validateEntryPath('/safe/plugins/my-plugin/entry.js', 'my-plugin'),
    ).not.toThrow();
  });

  it('rejects path traversal attempts', () => {
    const executor = new IsolatedPluginExecutor({ pluginsDir: '/safe/plugins' });
    expect(() =>
      (executor as unknown as { validateEntryPath(p: string, n: string): void })
        .validateEntryPath('/safe/plugins/../../../etc/passwd', 'traversal-plugin'),
    ).toThrow('越界');
  });

  it('skips validation when pluginsDir not configured', () => {
    const executor = new IsolatedPluginExecutor({});
    expect(() =>
      (executor as unknown as { validateEntryPath(p: string, n: string): void })
        .validateEntryPath('/any/absolute/path.js', 'test-plugin'),
    ).not.toThrow();
  });
});

describe('IsolatedPluginExecutor — fetch URL validation', () => {
  it('rejects non-http protocols', () => {
    const executor = new IsolatedPluginExecutor({});
    expect(() =>
      (executor as unknown as { validateFetchUrl(u: string): void })
        .validateFetchUrl('file:///etc/passwd'),
    ).toThrow('不允许的协议');
  });

  it('rejects disallowed hosts when allowedHosts configured', () => {
    const executor = new IsolatedPluginExecutor({ allowedHosts: ['api.example.com'] });
    expect(() =>
      (executor as unknown as { validateFetchUrl(u: string): void })
        .validateFetchUrl('https://evil.com/data'),
    ).toThrow('不允许的域名');
  });

  it('allows permitted hosts', () => {
    const executor = new IsolatedPluginExecutor({ allowedHosts: ['api.example.com'] });
    expect(() =>
      (executor as unknown as { validateFetchUrl(u: string): void })
        .validateFetchUrl('https://api.example.com/v1/data'),
    ).not.toThrow();
  });

  it('allows all https hosts when allowedHosts not configured', () => {
    const executor = new IsolatedPluginExecutor({});
    expect(() =>
      (executor as unknown as { validateFetchUrl(u: string): void })
        .validateFetchUrl('https://any-host.com/path'),
    ).not.toThrow();
  });
});
