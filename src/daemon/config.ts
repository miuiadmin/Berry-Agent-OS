export interface DaemonConfig {
  enabled: boolean;
  autoStart: boolean;
  maxSlots: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  taskTimeoutMs: number;
  runtimes: Record<string, RuntimeConfig>;
}

export interface RuntimeConfig {
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  enabled: false,
  autoStart: true,
  maxSlots: 2,
  heartbeatIntervalMs: 5000,
  heartbeatTimeoutMs: 15000,
  taskTimeoutMs: 300_000,
  runtimes: {},
};
