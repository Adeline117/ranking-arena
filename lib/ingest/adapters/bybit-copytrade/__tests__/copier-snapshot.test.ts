import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedCopierRow, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import { bybitCopytradeAdapter } from '../index'

const TRADER_ID = 'S9LoGlRC6qFD5thjUyzWrQ=='
const ATTEMPT_STARTED_AT = new Date(Date.now() - 1_000).toISOString()
const PARSED_AT = ATTEMPT_STARTED_AT
const COPIER_URL =
  'https://www.bybit.com/x-api/fapi/beehive/public/v1/common/other-follower' +
  '?hasOneself=true&leaderMark=S9LoGlRC6qFD5thjUyzWrQ%3D%3D' +
  '&pageAction=first_page&pageSize=50'

type Dict = Record<string, unknown>

function fixture(): Dict {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'other-follower-p1.json'), 'utf8')
  ) as Dict
}

function source(): SourceRow {
  return {
    id: 4,
    slug: 'bybit_copytrade',
    exchange_id: 4,
    product_type: 'futures',
    trader_kind_scope: 'mixed',
    adapter_slug: 'bybit_copytrade',
    leaderboard_url: 'https://www.bybit.com/copyTrade/',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 8_800,
    deep_profile_topn: 100,
    positions_topn: 100,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 16,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'local',
    rate_budget_ms: 500,
    phase: 1,
    serving_mode: 'serving',
    status: 'active',
    meta: {
      product_subtype: 'mixed_ui',
      bot_scope_series: true,
      platform_aggregates: true,
      click_all_traders: true,
    },
  }
}

function result(payload: Dict): Dict {
  return payload.result as Dict
}

function session(payload: Dict): { fetchSession: FetchSession; pageFetch: jest.Mock } {
  const page = {
    goto: jest.fn(async () => undefined),
    waitForLoadState: jest.fn(async () => undefined),
  }
  const pageFetch = jest.fn(async (_template: ReplayRequestTemplate) => ({
    status: 200,
    json: payload,
  }))
  return {
    pageFetch,
    fetchSession: {
      sourceSlug: 'bybit_copytrade',
      page: async () => page,
      pageFetch,
      paced: async <T>(fn: () => Promise<T>) => fn(),
    } as FetchSession,
  }
}

describe('Bybit copytrade copier publication evidence', () => {
  it('retains the exact public first page but never upgrades a normal return to terminal proof', async () => {
    const payload = fixture()
    const src = source()
    const { fetchSession, pageFetch } = session(payload)
    const acquisition = await captureHistoryAcquisition({
      source: src,
      traderId: 91,
      exchangeTraderId: TRADER_ID,
      kind: 'copiers',
      cursor: null,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      stream: bybitCopytradeAdapter.getHistory(fetchSession, src, TRADER_ID, 'copiers', null),
    })

    expect(pageFetch).toHaveBeenCalledTimes(1)
    expect(pageFetch.mock.calls[0][0]).toMatchObject({
      url: COPIER_URL,
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.pages[0]).toMatchObject({ pageIndex: 1, url: COPIER_URL })
    expect(acquisition.pages[0].payload).toEqual(payload)
    expect(acquisition.artifact.termination).toEqual({
      evidence_state: 'missing',
      claim_observations: [],
      verifier_contract: null,
      scan_terminal_state: 'unknown',
      terminal_cursor_value: null,
      overlap_event_at: null,
      blocker_reasons: ['terminal_claim_missing'],
    })

    const capturedPayload = acquisition.pages[0].payload as Dict
    const sourceRows = result(capturedPayload).data as Dict[]
    const rows = bybitCopytradeAdapter
      .parseHistory(capturedPayload, 'copiers', {
        sourceSlug: src.slug,
        currency: src.currency,
        tfLabelMap: src.tf_label_map,
        scrapedAt: PARSED_AT,
        meta: src.meta,
      })
      .filter((row): row is ParsedCopierRow => row.kind === 'copiers')
    expect(rows).toHaveLength(18)
    rows.forEach((row, index) => expect(row.raw).toBe(sourceRows[index]))
    expect(rows.every((row) => row.ts === PARSED_AT)).toBe(true)
  })

  it('locks the captured page as explicitly nonterminal and nonzero despite totalCount zero', () => {
    const envelope = fixture()
    const page = result(envelope)
    const rows = page.data as Dict[]

    expect(envelope).toEqual({
      retCode: 0,
      retMsg: 'success',
      result: expect.any(Object),
      retExtInfo: {},
      time: 1781212492800,
    })
    expect(Object.keys(page).sort()).toEqual(
      [
        'currentPage',
        'cursor',
        'data',
        'hasNext',
        'hasPrev',
        'isFirstPage',
        'isLastPage',
        'totalCount',
      ].sort()
    )
    expect(page).toMatchObject({
      currentPage: '1',
      totalCount: '0',
      cursor: 'KED4bUABNd',
      isFirstPage: true,
      hasPrev: false,
      hasNext: true,
      isLastPage: false,
    })
    expect(rows).toHaveLength(18)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('has no reviewed verifier because the captured public surface cannot prove full/top10/top3', () => {
    expect(bybitCopytradeAdapter.verifyCopierSnapshot).toBeUndefined()
    expect(source()).toMatchObject({
      trader_kind_scope: 'mixed',
      copier_table_depth: 'full',
    })
  })
})
