/**
 * Sanitize utilities for database queries
 */

/**
 * Escape user input for a LIKE/ILIKE pattern sent through Supabase PostgREST.
 *
 * Always escapes the SQL wildcards `%` `_` and the escape character.
 *
 * By default it also removes `.`, `,`, `(` and `)`, which are syntax inside a
 * hand-built `.or('a.ilike.x,b.ilike.y')` filter string.
 *
 * Pass `{ direct: true }` when the value goes to a direct
 * `.ilike(column, pattern)` / `.like()` call: there those characters are plain
 * text, and stripping them breaks searches for values that contain them
 * (dotted handles, email addresses). In that mode `*` is removed instead,
 * because PostgREST rewrites it to `%` and offers no escape for it.
 *
 * @param input - Raw user input
 * @param maxLength - Maximum allowed length (default: 200)
 */
export function escapeLikePattern(
  input: string,
  maxLength = 200,
  options: { direct?: boolean } = {}
): string {
  const escaped = input.slice(0, maxLength).replace(/[\\%_]/g, (c) => `\\${c}`)
  return options.direct ? escaped.replace(/\*/g, '') : escaped.replace(/[.,()]/g, '')
}
