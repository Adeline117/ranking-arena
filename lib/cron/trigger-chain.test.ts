import { assertSuccessfulFullLeaderboardComputeResponse } from './trigger-chain'

describe('full leaderboard trigger response contract', () => {
  it.each([
    [undefined, 'missing body'],
    [null, 'empty body'],
    [{ ok: false, stats: { seasons: { '7D': 10, '30D': 20, '90D': 30 } } }, 'ok:false'],
    [{ ok: true, stats: { seasons: { '7D': 10, '30D': 20 } } }, 'missing season'],
    [{ ok: true, stats: { seasons: { '7D': 10, '30D': 20, '90D': 0 } } }, 'zero season'],
    [
      {
        ok: true,
        stats: { seasons: { '7D': 10, '30D': 20, '90D': 30 } },
        warnings: ['30D degraded'],
      },
      'warning',
    ],
    [
      {
        ok: true,
        stats: { seasons: { '7D': 10, '30D': 20, '90D': 30 } },
        rolled_back: ['30D'],
      },
      'rollback',
    ],
    [
      {
        ok: true,
        stats: { seasons: { '7D': 10, '30D': 20, '90D': 30 } },
        empty_publications: ['90D'],
      },
      'empty publication',
    ],
    [{ ok: true, skipped: true, reason: 'degradation', season: '7D' }, 'invalid skip'],
    [
      { ok: true, skipped: true, reason: 'concurrent season compute', season: '1D' },
      'invalid lock season',
    ],
  ])('rejects an HTTP-200-shaped false success: %s (%s)', (body) => {
    expect(() => assertSuccessfulFullLeaderboardComputeResponse(body)).toThrow()
  })

  it('accepts only a complete positive three-season publication', () => {
    expect(
      assertSuccessfulFullLeaderboardComputeResponse({
        ok: true,
        stats: { seasons: { '7D': 101, '30D': 202, '90D': 303 } },
      })
    ).toBe('published')
  })

  it.each(['7D', '30D', '90D'])('accepts an exact active-season lock conflict for %s', (season) => {
    expect(
      assertSuccessfulFullLeaderboardComputeResponse({
        ok: true,
        skipped: true,
        reason: 'concurrent season compute',
        season,
      })
    ).toBe('concurrent')
  })
})
