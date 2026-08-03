import { assertSuccessfulFullLeaderboardComputeResponse } from './trigger-chain'

const published = (
  statuses: Partial<Record<'7D' | '30D' | '90D', string>> = {
    '7D': 'published',
    '30D': 'published',
    '90D': 'published',
  }
) => ({
  ok: true,
  stats: { seasons: { '7D': 101, '30D': 202, '90D': 303 } },
  publication_status: statuses,
})

describe('full leaderboard trigger response contract', () => {
  it.each([
    [undefined, 'missing body'],
    [null, 'empty body'],
    [{ ...published(), ok: false }, 'ok:false'],
    [
      {
        ...published({ '7D': 'published', '30D': 'published' }),
        stats: { seasons: { '7D': 101, '30D': 202 } },
      },
      'missing season',
    ],
    [{ ...published(), stats: { seasons: { '7D': 101, '30D': 202, '90D': 0 } } }, 'zero'],
    [{ ...published(), warnings: ['30D degraded'] }, 'warning'],
    [{ ...published(), publication_unsealed: ['30D'] }, 'partial unsealed publication'],
    [
      published({ '7D': 'published', '30D': 'degradation_skip', '90D': 'published' }),
      'degradation skip',
    ],
    [
      published({ '7D': 'published', '30D': 'database_finalized', '90D': 'published' }),
      'unsealed database status',
    ],
    [
      published({ '7D': 'checkpoint_skip', '30D': 'published', '90D': 'checkpoint_skip' }),
      'mixed target-set generation',
    ],
    [
      {
        ...published(),
        stats: { seasons: { '7D': 101, '30D': 202, '90D': 303, '1Y': 404 } },
      },
      'unexpected season',
    ],
  ])('rejects an HTTP-200-shaped false success: %s (%s)', (body) => {
    expect(() => assertSuccessfulFullLeaderboardComputeResponse(body)).toThrow()
  })

  it('accepts a complete positive three-season publication', () => {
    expect(() => assertSuccessfulFullLeaderboardComputeResponse(published())).not.toThrow()
  })

  it('accepts an exact same-hour checkpoint for the whole target set', () => {
    expect(() =>
      assertSuccessfulFullLeaderboardComputeResponse(
        published({ '7D': 'checkpoint_skip', '30D': 'checkpoint_skip', '90D': 'checkpoint_skip' })
      )
    ).not.toThrow()
  })
})
