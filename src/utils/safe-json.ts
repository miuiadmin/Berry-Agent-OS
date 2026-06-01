/**
 * Safe JSON.parse with fallback — never throws.
 * Use for parsing persisted/untrusted data where a SyntaxError
 * should not crash the caller.
 */
export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
