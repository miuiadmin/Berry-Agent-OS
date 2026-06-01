/**
 * Shared time constants for millisecond-based calculations.
 * Use these instead of raw numeric literals for readability.
 */
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;   // 60_000
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;      // 3_600_000
export const MS_PER_DAY = 24 * MS_PER_HOUR;          // 86_400_000

/** Common retry/poll intervals */
export const FAST_POLL_MS = 100;             // Agent readiness, queue drain
export const POLL_INTERVAL_MS = 200;        // Short poll (socket availability, process kill)
export const SLOW_POLL_INTERVAL_MS = 1000;  // Longer poll (agent readiness)

/** Common timeouts */
export const DRAIN_TIMEOUT_MS = 2000;       // Process/socket drain wait
export const LONG_DRAIN_TIMEOUT_MS = 6000;  // Extended drain (daemon pool)
export const MCP_RESTART_DELAY_MS = 3000;   // MCP server restart backoff
