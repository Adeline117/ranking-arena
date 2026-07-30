import type { SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import {
  supportsSourceSurface,
  UnsupportedSourceSurfaceError,
} from '../../../core/surface-capabilities'
import { okxAdapter } from '../index'

const UNIQUE_CODE = 'F503A5D5F1F6989F'

function source(productType: 'spot' | 'futures', instType: string): SourceRow {
  return {
    id: productType === 'spot' ? 35 : 34,
    slug: productType === 'spot' ? 'okx_spot' : 'okx_futures',
    exchange_id: 9,
    product_type: productType,
    trader_kind_scope: 'human',
    adapter_slug: 'okx',
    leaderboard_url: null,
    timeframes_native: [90],
    timeframes_derived: [7, 30],
    tf_label_map: {},
    expected_count: 200,
    deep_profile_topn: 100,
    positions_topn: 100,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'top10',
    currency: 'USDT',
    page_size: 20,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'vps_sg',
    rate_budget_ms: 500,
    phase: 3,
    serving_mode: 'serving',
    status: 'active',
    meta: { inst_type: instType },
  }
}

function session(): FetchSession {
  return {
    sourceSlug: 'okx',
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as FetchSession
}

function ok(data: unknown[] = []): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: '0', data, msg: '' }),
  } as Response
}

describe('OKX product-specific record contracts', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('declares SPOT record surfaces unsupported while keeping profile support', () => {
    const spot = source('spot', 'SPOT')

    expect(supportsSourceSurface(okxAdapter, spot, 'profile')).toBe(true)
    expect(supportsSourceSurface(okxAdapter, spot, 'positions')).toBe(false)
    expect(supportsSourceSurface(okxAdapter, spot, 'positionHistory')).toBe(false)
    expect(supportsSourceSurface(okxAdapter, spot, 'copiers')).toBe(false)
  })

  it('requires both the futures product dimension and SWAP instType', () => {
    expect(supportsSourceSurface(okxAdapter, source('spot', 'SWAP'), 'positions')).toBe(false)
    expect(supportsSourceSurface(okxAdapter, source('futures', 'SPOT'), 'positions')).toBe(false)
    expect(supportsSourceSurface(okxAdapter, source('futures', 'SWAP'), 'positions')).toBe(true)
  })

  it('fails closed before HTTP when a SPOT caller requests record surfaces', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch
    const spot = source('spot', 'SPOT')

    await expect(okxAdapter.getPositions(session(), spot, UNIQUE_CODE)).rejects.toBeInstanceOf(
      UnsupportedSourceSurfaceError
    )
    await expect(
      okxAdapter.getHistory(session(), spot, UNIQUE_CODE, 'position_history', null).next()
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SOURCE_SURFACE',
      sourceSlug: 'okx_spot',
      surface: 'positionHistory',
    })
    await expect(
      okxAdapter.getHistory(session(), spot, UNIQUE_CODE, 'copiers', null).next()
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SOURCE_SURFACE',
      sourceSlug: 'okx_spot',
      surface: 'copiers',
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('keeps SPOT profile requests on the explicit SPOT identity surface', async () => {
    const urls: string[] = []
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      urls.push(String(input))
      return ok()
    }) as unknown as typeof fetch

    await expect(
      okxAdapter.getProfile(session(), source('spot', 'SPOT'), UNIQUE_CODE, 90, null, {
        intent: 'scheduled_full',
      })
    ).resolves.toMatchObject({ pages: [{ payload: { timeframe: 90 } }] })

    expect(urls).toHaveLength(3)
    expect(urls.every((url) => url.includes('instType=SPOT'))).toBe(true)
    expect(urls.every((url) => url.includes(`uniqueCode=${UNIQUE_CODE}`))).toBe(true)
  })

  it('uses explicit SWAP on supported record requests', async () => {
    const urls: string[] = []
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      urls.push(String(input))
      return ok()
    }) as unknown as typeof fetch
    const futures = source('futures', 'SWAP')

    await okxAdapter.getPositions(session(), futures, UNIQUE_CODE)
    for await (const _page of okxAdapter.getHistory(
      session(),
      futures,
      UNIQUE_CODE,
      'position_history',
      null
    )) {
      // Empty response intentionally ends pagination.
    }
    for await (const _page of okxAdapter.getHistory(
      session(),
      futures,
      UNIQUE_CODE,
      'copiers',
      null
    )) {
      // One empty copier envelope is still a replayable page.
    }

    expect(urls).toEqual([
      expect.stringContaining(
        `public-current-subpositions?instType=SWAP&uniqueCode=${UNIQUE_CODE}`
      ),
      expect.stringContaining(
        `public-subpositions-history?instType=SWAP&uniqueCode=${UNIQUE_CODE}&limit=100`
      ),
      expect.stringContaining(`public-copy-traders?instType=SWAP&uniqueCode=${UNIQUE_CODE}`),
    ])
  })

  it('compares a stored close cursor with closeTime, not openTime', async () => {
    const urls: string[] = []
    const cursor = Date.parse('2026-07-01T00:00:00.000Z')
    const pages = [
      [
        {
          subPosId: 'newer-close',
          openTime: String(Date.parse('2026-06-01T00:00:00.000Z')),
          closeTime: String(Date.parse('2026-07-10T00:00:00.000Z')),
        },
      ],
      [
        {
          subPosId: 'cursor-overlap',
          openTime: String(Date.parse('2026-05-01T00:00:00.000Z')),
          closeTime: String(Date.parse('2026-06-30T00:00:00.000Z')),
        },
      ],
    ]
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      urls.push(String(input))
      return ok(pages[urls.length - 1] ?? [])
    }) as unknown as typeof fetch

    const captured = []
    for await (const page of okxAdapter.getHistory(
      session(),
      source('futures', 'SWAP'),
      UNIQUE_CODE,
      'position_history',
      new Date(cursor).toISOString()
    )) {
      captured.push(page)
    }

    expect(captured).toHaveLength(2)
    expect(captured[0].payload).toMatchObject({ historyTraderIdentity: UNIQUE_CODE })
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('after=newer-close')
  })

  it('yields replayable pages before rejecting an unproven page-cap stop', async () => {
    global.fetch = jest.fn(async () =>
      ok([
        {
          subPosId: 'still-has-older-rows',
          openTime: String(Date.parse('2026-07-01T00:00:00.000Z')),
          closeTime: String(Date.parse('2026-07-10T00:00:00.000Z')),
        },
      ])
    ) as unknown as typeof fetch

    const captured = []
    let failure: unknown = null
    try {
      for await (const page of okxAdapter.getHistory(
        session(),
        {
          ...source('futures', 'SWAP'),
          meta: { inst_type: 'SWAP', history_max_pages: 1 },
        },
        UNIQUE_CODE,
        'position_history',
        null
      )) {
        captured.push(page)
      }
    } catch (error) {
      failure = error
    }

    expect(captured).toHaveLength(1)
    expect(failure).toEqual(
      expect.objectContaining({
        message: '[okx] position history reached page cap 1 without exhaustion or cursor overlap',
      })
    )
  })

  it('rejects a non-empty history page without its continuation identity', async () => {
    global.fetch = jest.fn(async () =>
      ok([
        {
          openTime: String(Date.parse('2026-07-01T00:00:00.000Z')),
          closeTime: String(Date.parse('2026-07-10T00:00:00.000Z')),
        },
      ])
    ) as unknown as typeof fetch

    const iterator = okxAdapter
      .getHistory(session(), source('futures', 'SWAP'), UNIQUE_CODE, 'position_history', null)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    await expect(iterator.next()).rejects.toThrow(
      '[okx] position history page is missing the pagination subPosId'
    )
  })

  it('treats an invalid instType as configuration failure, not unsupported data', () => {
    expect(() =>
      supportsSourceSurface(okxAdapter, source('futures', 'MARGIN'), 'positions')
    ).toThrow('[okx] invalid inst_type "MARGIN"')
  })
})
