/**
 * Sanitize utilities for database queries
 */

/**
 * Escape special characters in LIKE/ILIKE patterns for Supabase PostgREST.
 * Prevents SQL injection via wildcard manipulation and PostgREST filter syntax injection.
 *
 * @param input - Raw user input
 * @param maxLength - Maximum allowed length (default: 200)
 * @returns Escaped string safe for use in .ilike() / .or() filters
 */
export function escapeLikePattern(input: string, maxLength = 200): string {
  return input
    .slice(0, maxLength)
    .replace(/[\\%_]/g, (c) => `\\${c}`) // Escape LIKE wildcards
    .replace(/[.,()]/g, '') // Remove PostgREST filter syntax chars
}

/**
 * Escape user input for a DIRECT `.ilike(column, pattern)` / `.like()` filter.
 *
 * Unlike {@link escapeLikePattern} this keeps `.`, `,`, `(` and `)`: those only
 * have meaning inside a hand-built `.or('a.ilike.x,b.ilike.y')` string, and
 * stripping them breaks searches for values that legitimately contain them
 * (dotted handles, email addresses). It escapes the SQL wildcards `%` `_` and
 * the escape character, and removes `*`, which PostgREST rewrites to `%` and
 * which cannot be escaped.
 *
 * Do NOT use this to build an `.or()` filter string — use escapeLikePattern.
 */
export function escapeIlikeValue(input: string, maxLength = 200): string {
  return input
    .slice(0, maxLength)
    .replace(/\*/g, '')
    .replace(/[\\%_]/g, (c) => `\\${c}`)
}
