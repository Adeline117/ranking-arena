import {
  assertSuccessfulLeaderboardComputeResponse,
  assertSuccessfulMeilisearchSyncResponse,
} from '../pipeline-response'

describe('pipeline Meilisearch response contract', () => {
  it.each([
    [undefined, 'missing body'],
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
  const published = (season: string, status: 'published' | 'checkpoint_skip' = 'published') => ({
    ok: true,
    stats: { seasons: { [season]: 1_200 } },
    publication_status: { [season]: status },
  })

  it.each([
    [undefined, 'missing body'],
    [{ ...published('90D'), ok: false }, 'ok:false'],
    [{ ...published('90D'), warnings: ['degraded'] }, 'warning'],
    [{ ...published('90D'), publication_unsealed: ['90D'] }, 'unsealed season'],
    [{ ...published('90D'), publication_status: { '90D': 'degradation_skip' } }, 'unsafe status'],
    [{ ...published('90D'), stats: { seasons: { '90D': 0 } } }, 'zero publication'],
    [
      {
        ...published('90D'),
        stats: { seasons: { '30D': 800, '90D': 1_200 } },
        publication_status: { '30D': 'published', '90D': 'published' },
      },
      'unexpected season',
    ],
  ])('rejects HTTP 200 fake compute success with a %s (%s)', (body) => {
    expect(() => assertSuccessfulLeaderboardComputeResponse(true, 200, body, '90D')).toThrow()
  })

  it.each(['published', 'checkpoint_skip'] as const)(
    'accepts an exact positive %s acknowledgement',
    (status) => {
      expect(() =>
        assertSuccessfulLeaderboardComputeResponse(true, 200, published('30D', status), '30D')
      ).not.toThrow()
    }
  )

  it('rejects a different or invalid requested season', () => {
    expect(() =>
      assertSuccessfulLeaderboardComputeResponse(true, 200, published('7D'), '30D')
    ).toThrow('incomplete publication acknowledgement')
    expect(() =>
      assertSuccessfulLeaderboardComputeResponse(true, 200, published('1D'), '1D')
    ).toThrow('invalid expected season')
  })

  it('rejects non-2xx responses before inspecting the payload', () => {
    expect(() =>
      assertSuccessfulLeaderboardComputeResponse(false, 503, published('90D'), '90D')
    ).toThrow('returned 503')
  })
})
