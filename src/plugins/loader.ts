import { pathToFileURL } from 'node:url';
import type { PluginDefinition } from './sdk.js';
import type { PluginManifest } from './types.js';

export interface LoadedPlugin {
  name: string;
  definition: PluginDefinition;
  manifest: PluginManifest;
}

export class PluginLoader {
  private loaded = new Map<string, LoadedPlugin>();

  async load(manifest: PluginManifest): Promise<LoadedPlugin> {
    if (this.loaded.has(manifest.name)) {
      return this.loaded.get(manifest.name)!;
    }

    const moduleUrl = pathToFileURL(manifest.entryPath).href;
    const mod = await import(moduleUrl);
    const definition = mod.default as PluginDefinition;

    if (!definition || typeof definition !== 'object' || !definition.name || !definition.tools) {
      throw new Error(`插件 ${manifest.name} 的 entry.ts 缺少有效的 default export (PluginDefinition)`);
    }

    if (definition.init) {
      await definition.init();
    }

    const loaded: LoadedPlugin = { name: manifest.name, definition, manifest };
    this.loaded.set(manifest.name, loaded);
    return loaded;
  }

  async unload(name: string): Promise<void> {
    const plugin = this.loaded.get(name);
    if (!plugin) return;

    if (plugin.definition.dispose) {
      await plugin.definition.dispose();
    }
    this.loaded.delete(name);
  }

  async unloadAll(): Promise<void> {
    for (const name of [...this.loaded.keys()]) {
      await this.unload(name);
    }
  }

  getLoaded(): Map<string, LoadedPlugin> {
    return this.loaded;
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }
}
