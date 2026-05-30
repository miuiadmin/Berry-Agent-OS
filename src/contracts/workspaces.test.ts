import { describe, expect, it } from 'vitest';
import {
  WorkspaceCapabilitySchema,
  WorkspaceSchema,
} from './workspaces.js';

describe('workspace contracts', () => {
  it('校验工作区记录', () => {
    const parsed = WorkspaceSchema.parse({
      id: 'ws_1',
      slug: 'main',
      name: '主工作区',
      workspaceDir: '/tmp/main',
      status: 'active',
      createdAt: 1,
      updatedAt: 2,
    });

    expect(parsed.slug).toBe('main');
  });

  it('拒绝非法能力类型', () => {
    expect(() => WorkspaceCapabilitySchema.parse({
      id: 'cap_1',
      workspaceId: 'ws_1',
      capabilityType: 'agent',
      capabilityId: 'x',
      enabled: true,
      configPath: null,
      configHash: null,
      createdAt: 1,
      updatedAt: 1,
    })).toThrow();
  });
});
