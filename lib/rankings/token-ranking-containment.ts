export const TOKEN_RANKING_NOT_PUBLISHED_CODE = 'TOKEN_RANKING_NOT_PUBLISHED' as const

export const TOKEN_RANKING_CONTAINMENT_RETRY_AFTER_SECONDS = 60 * 60

export const TOKEN_RANKING_CONTAINMENT_BODY = Object.freeze({
  error: 'Token rankings are withheld while verified authority snapshots are rebuilt',
  code: TOKEN_RANKING_NOT_PUBLISHED_CODE,
})

export const TOKEN_RANKING_CONTAINMENT_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'Retry-After': String(TOKEN_RANKING_CONTAINMENT_RETRY_AFTER_SECONDS),
})
