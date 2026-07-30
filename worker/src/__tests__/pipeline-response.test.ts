import {
  assertSuccessfulLeaderboardComputeResponse,
  assertSuccessfulMeilisearchSyncResponse,
} from '../pipeline-response'

describe('pipeline Meilisearch response contract', () => {
  it.each([
    [{ ok: false }, 'ok:false'],
    [{ ok: true, errors: { '30D': 'partial upload' } }, 'season errors'],
    [{ traders: 0 }, 'missing ok'],
  ])('rejects HTTP 200 fake success with %s (%s)', (body) => {
    expect(() => assertSuccessfulMeilisearchSyncResponse(true, 200, body)).toThrow(
      'unsuccessful payload'
    )
  })

  it('accepts HTTP success only when ok is exactly true and errors are empty', () => {
    expect(() =>
      assertSuccessfulMeilisearchSyncResponse(true, 200, { ok: true, errors: {} })
    ).not.toThrow()
  })
})

describe('pipeline leaderboard compute response contract', () => {
  it.each([
    [{ ok: false, stats: { seasons: { '90D': 1200 } } }, 'degradation guard'],
    [
      {
        ok: true,
        stats: { seasons: { '90D': 1200 } },
        warnings: ['90D rolled back'],
        rolled_back: ['90D'],
      },
      'rolled back season',
    ],
    [{ ok: true, stats: { seasons: { '90D': 0 } } }, 'zero publication'],
    [{ ok: true, stats: { seasons: {} } }, 'missing season count'],
    [{ ok: true, skipped: true, reason: 'degradation', season: '90D' }, 'invalid skip'],
  ])('rejects HTTP 200 fake compute success with %s (%s)', (body) => {
    expect(() => assertSuccessfulLeaderboardComputeResponse(true, 200, body, '90D')).toThrow()
  })

  it('accepts an exact positive publication acknowledgement', () => {
    expect(() =>
      assertSuccessfulLeaderboardComputeResponse(
        true,
        200,
        { ok: true, stats: { seasons: { '30D': 8421 } } },
        '30D'
      )
    ).not.toThrow()
  })

  it('accepts only the exact same-season concurrency skip', () => {
    const body = {
      ok: true,
      skipped: true,
      reason: 'concurrent season compute',
      season: '7D',
    }
    expect(() => assertSuccessfulLeaderboardComputeResponse(true, 200, body, '7D')).not.toThrow()
    expect(() => assertSuccessfulLeaderboardComputeResponse(true, 200, body, '30D')).toThrow(
      'invalid skip acknowledgement'
    )
  })

  it('rejects non-2xx responses before inspecting the payload', () => {
    expect(() =>
      assertSuccessfulLeaderboardComputeResponse(false, 503, { ok: true }, '90D')
    ).toThrow('returned 503')
  })
})
