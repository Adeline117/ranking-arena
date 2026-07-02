/**
 * Unified post display-title resolution.
 *
 * Before this, the hot page had three disagreeing behaviors: the server
 * mapper (page.tsx) normalized the literal 'Untitled' to '', the client
 * mapper (useHotPageData) baked the localized t('noTitle') placeholder INTO
 * the data, PostCard filtered the English literals 'Untitled'/'untitled'
 * only, and PostDetailModal rendered post.title raw — so the modal showed
 * "Untitled" (and set it as the dialog's aria-label) while the list card
 * showed a body excerpt for the same post.
 *
 * Rules enforced here:
 * - Placeholder titles ('Untitled', case-insensitive) and whitespace-only
 *   titles are treated as EMPTY at the data layer — display placeholders
 *   (t('noTitle')) belong at render points, never in stored/mapped data.
 * - When a post has no real title, surfaces fall back to a body excerpt.
 */

/** Truncation length for body-as-title fallback (matches hot PostCard). */
const TITLE_FALLBACK_MAX_LEN = 80

/**
 * Normalize a raw post title: returns '' for null/whitespace-only titles and
 * for the legacy 'Untitled' placeholder some write paths persisted. Trigger
 * on emptiness downstream — never string-match localized placeholders.
 */
export function normalizePostTitle(title?: string | null): string {
  const trimmed = (title ?? '').trim()
  if (!trimmed || trimmed.toLowerCase() === 'untitled') return ''
  return trimmed
}

/**
 * Resolve the title to display for a post: the real title when present,
 * otherwise an excerpt of the body. Returns '' only when both are empty —
 * callers needing a guaranteed non-empty string (e.g. dialog aria-label)
 * should append `|| t('noTitle')` at the render point.
 */
export function resolvePostDisplayTitle(
  title?: string | null,
  body?: string | null,
  maxLen = TITLE_FALLBACK_MAX_LEN
): string {
  const normalized = normalizePostTitle(title)
  if (normalized) return normalized
  const excerpt = (body ?? '').trim()
  if (!excerpt) return ''
  return excerpt.length > maxLen ? `${excerpt.slice(0, maxLen)}…` : excerpt
}
