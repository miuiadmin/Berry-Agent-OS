import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WorkspaceManager } from './manager.js';
import { EventBus } from '../kernel/event-bus.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

describe('WorkspaceManager', () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let manager: WorkspaceManager;

  beforeEach(() => {
    db = createTestDb();
    eventBus = new EventBus();
    manager = new WorkspaceManager(db, eventBus);
  });

  afterEach(() => {
    db.close();
  });

  it('创建工作区', () => {
    const ws = manager.create({ slug: 'my-project', name: '我的项目', workspaceDir: '/tmp/project' });
    expect(ws.id).toMatch(/^ws_/);
    expect(ws.slug).toBe('my-project');
    expect(ws.name).toBe('我的项目');
    expect(ws.status).toBe('active');
  });

  it('slug 唯一性约束', () => {
    manager.create({ slug: 'proj', name: 'P1', workspaceDir: '/tmp/p1' });
    expect(() => manager.create({ slug: 'proj', name: 'P2', workspaceDir: '/tmp/p2' })).toThrow();
  });

  it('按 ID 和 slug 查询', () => {
    const ws = manager.create({ slug: 'test', name: 'Test', workspaceDir: '/tmp/test' });
    expect(manager.get(ws.id)?.slug).toBe('test');
    expect(manager.getBySlug('test')?.id).toBe(ws.id);
    expect(manager.getBySlug('nonexistent')).toBeNull();
  });

  it('按目录查询', () => {
    manager.create({ slug: 'dir-test', name: 'Dir', workspaceDir: '/projects/foo' });
    const found = manager.getByDir('/projects/foo');
    expect(found).not.toBeNull();
    expect(found!.slug).toBe('dir-test');
  });

  it('列表和过滤', () => {
    manager.create({ slug: 'a', name: 'A', workspaceDir: '/tmp/a' });
    manager.create({ slug: 'b', name: 'B', workspaceDir: '/tmp/b' });
    const ws = manager.create({ slug: 'c', name: 'C', workspaceDir: '/tmp/c' });
    manager.update(ws.id, { status: 'archived' });

    expect(manager.list()).toHaveLength(3);
    expect(manager.list({ status: 'active' })).toHaveLength(2);
    expect(manager.list({ status: 'archived' })).toHaveLength(1);
  });

  it('更新工作区', () => {
    const ws = manager.create({ slug: 'upd', name: 'Original', workspaceDir: '/tmp/upd' });
    const updated = manager.update(ws.id, { name: '新名称', status: 'disabled' });
    expect(updated?.name).toBe('新名称');
    expect(updated?.status).toBe('disabled');
  });

  it('注册和查询能力', () => {
    const ws = manager.create({ slug: 'cap', name: 'Cap', workspaceDir: '/tmp/cap' });
    const cap = manager.registerCapability({
      workspaceId: ws.id,
      capabilityType: 'skill',
      capabilityId: 'json-formatter',
    });

    expect(cap.id).toMatch(/^wc_/);
    expect(cap.capabilityType).toBe('skill');
    expect(cap.enabled).toBe(true);
  });

  it('获取工作区覆盖层', () => {
    const ws = manager.create({ slug: 'ov', name: 'Overlay', workspaceDir: '/tmp/ov' });
    manager.registerCapability({ workspaceId: ws.id, capabilityType: 'skill', capabilityId: 's1' });
    manager.registerCapability({ workspaceId: ws.id, capabilityType: 'plugin', capabilityId: 'p1' });
    manager.registerCapability({ workspaceId: ws.id, capabilityType: 'mcp', capabilityId: 'm1' });

    const overlay = manager.getOverlay(ws.id);
    expect(overlay.skills).toHaveLength(1);
    expect(overlay.plugins).toHaveLength(1);
    expect(overlay.mcps).toHaveLength(1);
  });

  it('移除能力', () => {
    const ws = manager.create({ slug: 'rm', name: 'RM', workspaceDir: '/tmp/rm' });
    manager.registerCapability({ workspaceId: ws.id, capabilityType: 'skill', capabilityId: 's1' });
    manager.removeCapability(ws.id, 'skill', 's1');

    const caps = manager.listCapabilities(ws.id);
    expect(caps).toHaveLength(0);
  });

  it('创建时触发事件', () => {
    const events: unknown[] = [];
    eventBus.on('workspace.created' as any, (p: unknown) => events.push(p));

    manager.create({ slug: 'evt', name: 'Evt', workspaceDir: '/tmp/evt' });
    expect(events).toHaveLength(1);
    expect((events[0] as any).slug).toBe('evt');
  });
});
