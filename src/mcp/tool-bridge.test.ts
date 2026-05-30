import { describe, it, expect, vi } from 'vitest';
import {
  mcpToolFullName,
  parseMcpToolName,
  inferDangerLevel,
  filterMcpTools,
  mcpToolToDefinition,
  convertMcpTools,
} from './tool-bridge.js';

vi.mock('./security.js', () => ({
  scanToolDescription: vi.fn(),
  sanitizeCredentials: vi.fn((msg: string) => msg),
  truncateOutput: vi.fn((s: string) => s),
}));

describe('mcp/tool-bridge', () => {
  describe('mcpToolFullName', () => {
    it('formats server:tool name', () => {
      expect(mcpToolFullName('github', 'search')).toBe('mcp:github:search');
    });

    it('handles names with special chars', () => {
      expect(mcpToolFullName('my-server', 'do_thing')).toBe('mcp:my-server:do_thing');
    });
  });

  describe('parseMcpToolName', () => {
    it('parses valid full name', () => {
      expect(parseMcpToolName('mcp:github:search')).toEqual({
        serverName: 'github',
        toolName: 'search',
      });
    });

    it('handles tool names with colons', () => {
      expect(parseMcpToolName('mcp:srv:ns:tool')).toEqual({
        serverName: 'srv',
        toolName: 'ns:tool',
      });
    });

    it('returns null for invalid format', () => {
      expect(parseMcpToolName('not-mcp-name')).toBeNull();
      expect(parseMcpToolName('mcp:')).toBeNull();
      expect(parseMcpToolName('mcp:server')).toBeNull();
    });
  });

  describe('inferDangerLevel', () => {
    it('read-prefixed tools are safe', () => {
      expect(inferDangerLevel('readFile', '', 'moderate')).toBe('safe');
      expect(inferDangerLevel('getUser', '', 'moderate')).toBe('safe');
      expect(inferDangerLevel('listItems', '', 'moderate')).toBe('safe');
      expect(inferDangerLevel('search_docs', '', 'dangerous')).toBe('safe');
      expect(inferDangerLevel('query_db', '', 'dangerous')).toBe('safe');
    });

    it('write-prefixed tools are dangerous', () => {
      expect(inferDangerLevel('writeFile', '', 'safe')).toBe('dangerous');
      expect(inferDangerLevel('deleteUser', '', 'safe')).toBe('dangerous');
      expect(inferDangerLevel('execute_sql', '', 'safe')).toBe('dangerous');
      expect(inferDangerLevel('run_command', '', 'safe')).toBe('dangerous');
    });

    it('description keywords override', () => {
      expect(inferDangerLevel('updateSetting', 'This is destructive and irreversible', 'safe')).toBe('dangerous');
    });

    it('falls back to server default', () => {
      expect(inferDangerLevel('doThing', 'some normal tool', 'moderate')).toBe('moderate');
      expect(inferDangerLevel('process', '', 'safe')).toBe('safe');
    });
  });

  describe('filterMcpTools', () => {
    const tools = [
      { name: 'read', description: '', inputSchema: {} },
      { name: 'write', description: '', inputSchema: {} },
      { name: 'delete', description: '', inputSchema: {} },
    ] as any[];

    it('returns all when no include/exclude', () => {
      const result = filterMcpTools(tools, { name: 'srv' } as any);
      expect(result).toHaveLength(3);
    });

    it('filters by include list', () => {
      const result = filterMcpTools(tools, { name: 'srv', tools: { include: ['read'] } } as any);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read');
    });

    it('filters by exclude list', () => {
      const result = filterMcpTools(tools, { name: 'srv', tools: { exclude: ['delete'] } } as any);
      expect(result).toHaveLength(2);
      expect(result.map(t => t.name)).toEqual(['read', 'write']);
    });

    it('include takes precedence (only included tools pass)', () => {
      const result = filterMcpTools(tools, {
        name: 'srv',
        tools: { include: ['read', 'write'], exclude: ['write'] },
      } as any);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read');
    });
  });

  describe('mcpToolToDefinition', () => {
    const mockClient = {
      callTool: vi.fn(),
    };

    const ctx = {
      client: mockClient as any,
      config: { name: 'test-srv', dangerLevel: 'moderate', timeout: 5000 } as any,
      getCircuitState: () => 'closed' as const,
      onError: vi.fn(),
    };

    it('creates tool definition with correct name', () => {
      const tool = { name: 'search', description: 'Search things', inputSchema: {} } as any;
      const def = mcpToolToDefinition(tool, ctx);
      expect(def.name).toBe('mcp:test-srv:search');
      expect(def.description).toContain('Search things');
      expect(def.dangerLevel).toBe('safe');
    });

    it('executor returns circuit breaker error when open', async () => {
      const openCtx = { ...ctx, getCircuitState: () => 'open' as const };
      const tool = { name: 'thing', description: '', inputSchema: {} } as any;
      const def = mcpToolToDefinition(tool, openCtx);
      const result = await def.execute({});
      expect(result.isError).toBe(true);
      expect(result.content).toContain('熔断');
    });

    it('executor calls client.callTool and returns content', async () => {
      mockClient.callTool.mockResolvedValue({
        content: [{ type: 'text', text: 'result here' }],
        isError: false,
      });
      const tool = { name: 'fetch', description: '', inputSchema: {} } as any;
      const def = mcpToolToDefinition(tool, ctx);
      const result = await def.execute({ url: 'http://x' });
      expect(result.content).toBe('result here');
      expect(result.isError).toBe(false);
    });

    it('executor handles errors gracefully', async () => {
      mockClient.callTool.mockRejectedValue(new Error('connection refused'));
      const tool = { name: 'broken', description: '', inputSchema: {} } as any;
      const def = mcpToolToDefinition(tool, ctx);
      const result = await def.execute({});
      expect(result.isError).toBe(true);
      expect(result.content).toContain('connection refused');
      expect(ctx.onError).toHaveBeenCalled();
    });
  });

  describe('convertMcpTools', () => {
    it('converts array of tools', () => {
      const tools = [
        { name: 'a', description: '', inputSchema: {} },
        { name: 'b', description: '', inputSchema: {} },
      ] as any[];
      const ctx = {
        client: {} as any,
        config: { name: 'srv', dangerLevel: 'moderate', timeout: 5000 } as any,
        getCircuitState: () => 'closed' as const,
        onError: vi.fn(),
      };
      const defs = convertMcpTools(tools, ctx);
      expect(defs).toHaveLength(2);
      expect(defs[0].name).toBe('mcp:srv:a');
      expect(defs[1].name).toBe('mcp:srv:b');
    });
  });
});
