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
    .replace(/[\\%_]/g, c => `\\${c}`)   // Escape LIKE wildcards
    .replace(/[.,()]/g, '')               // Remove PostgREST filter syntax chars
}
