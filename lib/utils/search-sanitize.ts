/**
 * Search query sanitization utilities.
 *
 * Filters out SQL injection attempts, XSS payloads, command injection, and other
 * clearly malicious strings so they never appear as "Popular Search" pills or
 * pollute the search_analytics table.
 */

const SQL_INJECTION_PATTERN =
  /(\b(drop|delete|insert|update|alter|truncate|exec|execute|union\s+select|into\s+outfile|load_file|benchmark|sleep|waitfor)\b|--|;|\b(or|and)\b\s+\d+\s*=\s*\d+|'\s*(or|and)\s+|\/\*|\*\/|xp_|sp_)/i

const XSS_PATTERN =
  /(<\s*script|javascript\s*:|on\w+\s*=|<\s*iframe|<\s*img\s+[^>]*onerror|<\s*svg|<\s*object|<\s*embed|data\s*:\s*text\/html|vbscript\s*:)/i

const COMMAND_INJECTION_PATTERN =
  /(\||&&|`|;|\$\(|>\s*\/|<\s*\/|\\x[0-9a-f]{2}|%0[ad])/i

/**
 * Returns true if a search query looks malicious / is clearly not a legitimate
 * search term.  Used to:
 *  1. Prevent SQL injection text from appearing in "Popular Searches" pills
 *  2. Block malicious queries from being logged to search_analytics
 */
export function isMaliciousSearchQuery(q: string): boolean {
  if (!q) return true
  if (SQL_INJECTION_PATTERN.test(q)) return true
  if (XSS_PATTERN.test(q)) return true
  if (COMMAND_INJECTION_PATTERN.test(q)) return true
  // Excessive special characters (legitimate search terms are mostly alphanumeric)
  const specialCharRatio = q.replace(/[a-zA-Z0-9\s@._\-#$/]/g, '').length / q.length
  if (q.length > 3 && specialCharRatio > 0.4) return true
  return false
}
