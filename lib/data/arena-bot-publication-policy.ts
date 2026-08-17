/**
 * The system account used by legacy automated market/ranking posts.
 *
 * This is intentionally an immutable UUID comparison, never a handle/title/
 * content heuristic: a user may legitimately choose a similar handle, while
 * historical generated text has no receipt that can prove it safe to publish.
 */
export const ARENA_BOT_AUTHOR_ID = '00000000-0000-0000-0000-000000000001' as const

/**
 * Bumps every application cache key that can contain a rendered post payload.
 * The companion maintenance script purges persistent Vercel Data/CDN entries
 * created before this fence; the epoch protects rolling instances meanwhile.
 */
export const ARENA_BOT_PUBLICATION_CACHE_EPOCH = 'arena-bot-publication-fence-v1' as const

export function isQuarantinedArenaBotAuthor(authorId: unknown): boolean {
  return authorId === ARENA_BOT_AUTHOR_ID
}
