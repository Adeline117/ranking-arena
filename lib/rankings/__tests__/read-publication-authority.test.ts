/**
 * @jest-environment node
 */

import {
  ReadPublicationAuthorityError,
  readLeaderboardPublicationAuthority,
  type ReadPublicationAuthorityErrorCode,
} from '@/lib/rankings/read-publication-authority'

function authorityRow(
  registrySlug: string,
  filterSource: string,
  seasonId: string,
  exchangeName = 'Exchange'
) {
  return {
    registry_slug: registrySlug,
    filter_source: filterSource,
    exchange_name: exchangeName,
    season_id: seasonId,
  }
}

function supabaseReturning(data: unknown, error: unknown = null) {
  return {
    rpc: jest.fn().mockResolvedValue({ data, error, status: error === null ? 200 : 400 }),
  }
}

async function captureError(
  operation: Promise<unknown>,
  expectedCode: ReadPublicationAuthorityErrorCode
): Promise<ReadPublicationAuthorityError> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(ReadPublicationAuthorityError)
    expect((error as ReadPublicationAuthorityError).code).toBe(expectedCode)
    return error as ReadPublicationAuthorityError
  }
  throw new Error(`expected ReadPublicationAuthorityError(${expectedCode})`)
}

describe('readLeaderboardPublicationAuthority', () => {
  it('returns distinct sorted aliases for the requested season', async () => {
    const supabase = supabaseReturning([
      authorityRow('bybit_perps', 'bybit', '90D', 'Bybit'),
      authorityRow('binance_perps', 'binance_futures', '90D', 'Binance'),
      authorityRow('binance_copy', 'binance_futures', '90D', 'Binance'),
      authorityRow('binance_perps', 'binance_futures', '30D', 'Binance'),
    ])

    await expect(readLeaderboardPublicationAuthority(supabase as never, '90D')).resolves.toEqual([
      'binance_futures',
      'bybit',
    ])
    expect(supabase.rpc).toHaveBeenCalledWith('arena_freshness_expected_sources')
  })

  it('fails closed when the requested season has no authority rows', async () => {
    const supabase = supabaseReturning([
      authorityRow('binance_perps', 'binance_futures', '30D', 'Binance'),
    ])

    await captureError(
      readLeaderboardPublicationAuthority(supabase as never, '90D'),
      'rpc_shape_mismatch'
    )
  })

  it.each([
    ['uppercase alias', authorityRow('alpha', 'Alpha', '90D')],
    ['hyphenated alias', authorityRow('alpha', 'alpha-beta', '90D')],
    ['null sentinel', authorityRow('alpha', 'null', '90D')],
  ])('rejects a non-canonical authority source: %s', async (_label, row) => {
    const supabase = supabaseReturning([row])
    await captureError(
      readLeaderboardPublicationAuthority(supabase as never, '90D'),
      'rpc_shape_mismatch'
    )
  })

  it('rejects an authority RPC error without returning a partial set', async () => {
    const supabase = supabaseReturning(null, { code: '42501', message: 'permission denied' })
    await captureError(readLeaderboardPublicationAuthority(supabase as never, '90D'), 'rpc_error')
  })

  it('does not dispatch when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const supabase = supabaseReturning([
      authorityRow('binance_perps', 'binance_futures', '90D', 'Binance'),
    ])

    await captureError(
      readLeaderboardPublicationAuthority(supabase as never, '90D', {
        signal: controller.signal,
      }),
      'rpc_aborted'
    )
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
