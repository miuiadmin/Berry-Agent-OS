import { watch, type FSWatcher } from 'node:fs';
import { join, relative } from 'node:path';
import type { EventBus } from '../contracts/infrastructure.js';
import type { WorkspaceManager } from './manager.js';

const DEBOUNCE_MS = 300;
const SKILL_PATTERN = /SKILL\.md$/;
const PLUGIN_PATTERN = /plugin\.json$/;
const MCP_PATTERN = /mcp\.(json|yaml)$/;

export class WorkspaceWatcher {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly manager: WorkspaceManager,
    private readonly eventBus: EventBus | null,
  ) {}

  watch(workspaceId: string, dir: string): void {
    if (this.watchers.has(workspaceId)) return;

    try {
      const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        this.debounce(`${workspaceId}:${filename}`, () => {
          this.handleChange(workspaceId, dir, filename, eventType);
        });
      });
      this.watchers.set(workspaceId, watcher);
    } catch {
      // directory may not exist or be inaccessible
    }
  }

  unwatch(workspaceId: string): void {
    const watcher = this.watchers.get(workspaceId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(workspaceId);
    }
  }

  dispose(): void {
    for (const [id] of this.watchers) {
      this.unwatch(id);
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private handleChange(workspaceId: string, baseDir: string, filename: string, eventType: string): void {
    const fullPath = join(baseDir, filename);
    const changeType = eventType === 'rename' ? 'file_created' : 'file_changed';

    this.eventBus?.emit('workspace.file_changed', {
      workspaceId,
      path: fullPath,
      changeType,
    });

    if (SKILL_PATTERN.test(filename)) {
      this.eventBus?.emit('workspace.file_changed', {
        workspaceId,
        path: fullPath,
        changeType: 'skill_detected',
      });
    } else if (PLUGIN_PATTERN.test(filename)) {
      this.eventBus?.emit('workspace.file_changed', {
        workspaceId,
        path: fullPath,
        changeType: 'plugin_detected',
      });
    } else if (MCP_PATTERN.test(filename)) {
      this.eventBus?.emit('workspace.file_changed', {
        workspaceId,
        path: fullPath,
        changeType: 'mcp_detected',
      });
    }
  }

  private debounce(key: string, fn: () => void): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, DEBOUNCE_MS));
  }
}
