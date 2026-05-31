/**
 * Safe extraction helpers for database row deserialization.
 * Replaces unsafe `row.field as string` casts with validated extraction.
 *
 * @module db/row-helpers
 */

/**
 * Extract a required string from a DB row. Throws if missing or not a string.
 */
export function reqStr(row: Record<string, unknown>, field: string): string {
  const val = row[field];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`DB row missing required string field '${field}' (got ${typeof val}: ${JSON.stringify(val)?.slice(0, 50)})`);
  }
  return val;
}

/**
 * Extract an optional string from a DB row. Returns fallback if missing.
 */
export function optStr(row: Record<string, unknown>, field: string, fallback: string | null = null): string | null {
  const val = row[field];
  return typeof val === 'string' ? val : fallback;
}

/**
 * Extract a required number from a DB row. Throws if missing or not a number.
 */
export function reqNum(row: Record<string, unknown>, field: string): number {
  const val = row[field];
  if (typeof val !== 'number') {
    throw new Error(`DB row missing required number field '${field}' (got ${typeof val}: ${JSON.stringify(val)})`);
  }
  return val;
}

/**
 * Extract an optional number from a DB row. Returns fallback if missing.
 */
export function optNum(row: Record<string, unknown>, field: string, fallback: number | null = null): number | null {
  const val = row[field];
  return typeof val === 'number' ? val : fallback;
}

/**
 * Extract a required boolean-like value (stored as INTEGER in SQLite).
 */
export function reqBool(row: Record<string, unknown>, field: string): boolean {
  const val = row[field];
  return typeof val === 'number' ? val !== 0 : Boolean(val);
}

/**
 * Extract and parse a JSON string field from a DB row.
 * Returns fallback if missing or parse fails.
 */
export function optJson<T>(row: Record<string, unknown>, field: string, fallback: T): T {
  const val = row[field];
  if (typeof val !== 'string') return fallback;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}
