import type { PluginRecord, PluginExecResultV2 } from '../../contracts/plugins-v2.js';
import type { IsolatedPluginExecutor } from '../isolated-runtime.js';

export class CodeFacet {
  constructor(private readonly executor: IsolatedPluginExecutor) {}

  async execute(
    plugin: PluginRecord,
    input: unknown,
    timeoutMs = 30000,
  ): Promise<PluginExecResultV2> {
    if (!plugin.hasCode) {
      return { ok: false, error: 'Plugin has no code facet', durationMs: 0 };
    }

    const manifest = plugin.manifestJson;
    if (!manifest?.facets.code) {
      return { ok: false, error: 'Missing code facet config in manifest', durationMs: 0 };
    }

    const effectiveTimeout = manifest.facets.code.timeout ?? timeoutMs;
    const t0 = Date.now();

    try {
      const result = await this.executor.execute(
        plugin.name,
        '__code_exec__',
        input,
        effectiveTimeout,
      );
      const durationMs = Date.now() - t0;
      return result.ok
        ? { ok: true, output: result.output, durationMs }
        : { ok: false, error: result.error, durationMs };
    } catch (err) {
      return { ok: false, error: (err as Error).message, durationMs: Date.now() - t0 };
    }
  }

  async spawn(plugin: PluginRecord, pluginsDir: string): Promise<void> {
    if (!plugin.hasCode || !plugin.manifestJson?.facets.code) return;
    const entryPath = `${pluginsDir}/${plugin.name}/${plugin.manifestJson.facets.code.entrypoint}`;
    await this.executor.spawn(plugin.name, entryPath);
  }
}
