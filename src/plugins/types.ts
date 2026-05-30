export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  pluginDir: string;
  manifestPath: string;
  entryPath: string;
  apiVersion: string;
  source: 'bundled' | 'generated' | 'user' | 'installed';
  status: 'draft' | 'validating' | 'pending_review' | 'pending_user_confirm' | 'enabled' | 'disabled' | 'failed' | 'quarantined' | 'rolled_back';
  riskLevel: 'low' | 'medium' | 'high';
  capabilities: Record<string, unknown>;
  permissions: Record<string, unknown>;
}

export interface PluginDraftInput {
  name: string;
  description: string;
  evidence: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface PluginValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  tools: Array<{
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    permissionScope: string;
  }>;
}

export interface PluginInspection {
  manifest: PluginManifest;
  manifestFile: Record<string, unknown> | null;
  validation: PluginValidationResult;
  tools: Array<{
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    permissionScope: string;
    enabled: boolean;
  }>;
  recentEvents: Array<{
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: number;
  }>;
}

export interface PluginDryRunResult {
  ok: boolean;
  plugin: string;
  tool: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  permissionScope?: string;
  mode: 'fixture-runtime';
}

export interface PluginFixtureTestResult {
  ok: boolean;
  plugin: string;
  total: number;
  passed: number;
  failed: number;
  results: Array<{
    name: string;
    ok: boolean;
    tool: string;
    error?: string;
    output?: Record<string, unknown>;
  }>;
}
