import {
  isTokenRankingNotPublishedResponse,
  TOKEN_RANKING_NOT_PUBLISHED_CODE,
} from './token-ranking-api-contract'

describe('token ranking API publication contract', () => {
  it('requires both HTTP 503 and the exact unpublished code', () => {
    expect(
      isTokenRankingNotPublishedResponse(503, { code: TOKEN_RANKING_NOT_PUBLISHED_CODE })
    ).toBe(true)

    for (const [status, body] of [
      [200, { code: TOKEN_RANKING_NOT_PUBLISHED_CODE }],
      [502, { code: TOKEN_RANKING_NOT_PUBLISHED_CODE }],
      [503, { code: 'TOKEN_RANKING_UNAVAILABLE' }],
      [503, null],
      [503, []],
      [503, TOKEN_RANKING_NOT_PUBLISHED_CODE],
    ] as const) {
      expect(isTokenRankingNotPublishedResponse(status, body)).toBe(false)
    }
  })
})
