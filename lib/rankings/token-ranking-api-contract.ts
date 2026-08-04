export const TOKEN_RANKING_NOT_PUBLISHED_CODE = 'TOKEN_RANKING_NOT_PUBLISHED' as const

export function isTokenRankingNotPublishedResponse(status: number, body: unknown): boolean {
  if (status !== 503 || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return false
  }

  return (body as Record<string, unknown>).code === TOKEN_RANKING_NOT_PUBLISHED_CODE
}
