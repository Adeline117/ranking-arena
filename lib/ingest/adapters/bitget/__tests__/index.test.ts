import type { SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { bitgetAdapter } from '../index'

const TRADER_ID = 'bitget-trader-1'

const src: SourceRow = {
  id: 4,
  slug: 'bitget_futures',
  exchange_id: 4,
  product_type: 'futures',
  trader_kind_scope: 'human',
  adapter_slug: 'bitget',
  leaderboard_url: 'https://www.bitget.com/zh-CN/copy-trading/futures',
  timeframes_native: [7, 30, 90],
  timeframes_derived: [],
  tf_label_map: {},
  expected_count: null,
  deep_profile_topn: 200,
  positions_topn: 200,
  profile_cache_ttl: '1 hour',
  copier_table_depth: 'top50',
  currency: 'USDT',
  page_size: 30,
  pagination_kind: 'numeric',
  cadence_tier_a: '2 hours',
  cadence_tier_b: '12 hours',
  cadence_tier_d: '1 hour',
  fetch_region: 'local',
  rate_budget_ms: 1_000,
  phase: 2,
  serving_mode: 'serving',
  status: 'active',
  meta: { history_max_pages: 1 },
}

function session(response: unknown): FetchSession {
  return {
    sourceSlug: src.slug,
    page: async () =>
      ({
        goto: async () => null,
        waitForLoadState: async () => null,
      }) as unknown as Awaited<ReturnType<FetchSession['page']>>,
    pageFetch: async (_template: ReplayRequestTemplate) => ({ status: 200, json: response }),
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as FetchSession
}

function fullPositionPage(nextFlag: boolean): unknown {
  return {
    data: {
      rows: Array.from({ length: 20 }, (_, index) => ({
        orderNo: `order-${index}`,
        closeTime: Date.parse('2026-07-20T00:00:00.000Z') - index,
      })),
      nextFlag,
    },
  }
}

describe('Bitget history termination', () => {
  it('yields replayable data before rejecting an unproven page-cap stop', async () => {
    const captured = []
    let failure: unknown = null
    try {
      for await (const page of bitgetAdapter.getHistory(
        session(fullPositionPage(true)),
        src,
        TRADER_ID,
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
        message: '[bitget] position_history reached page cap 1 without terminal proof',
      })
    )
  })

  it('accepts an explicit upstream end marker on a full final page', async () => {
    const captured = []
    for await (const page of bitgetAdapter.getHistory(
      session(fullPositionPage(false)),
      src,
      TRADER_ID,
      'position_history',
      null
    )) {
      captured.push(page)
    }

    expect(captured).toHaveLength(1)
  })
})
