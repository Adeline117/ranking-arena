/**
 * Public boards that report no row total (okx_futures, okx_spot,
 * binance_web3_bsc) are proven complete by exhaustion. Per source: replay a
 * fixture sanitized from a live probe through the adapter's own
 * `captureLeaderboard`, parse and validate exactly as Tier-A does, and run the
 * attempt-bound evidence predicate with the registered declaration. A
 * truncated, duplicated, or version-shifted board must never bind.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { SourceAdapter } from '../core/adapter'
import type { RankingTimeframe, SourceRow } from '../core/types'
import { LeaderboardCaptureUpstreamError, type LeaderboardCapture } from '../fetch/capture'
import type { FetchSession } from '../fetch/types'
import { validateLeaderboardRows } from '../staging/validate'
import { attemptBoundEvidenceForCapture } from '../testing/attempt-bound-evidence'
import type { LeaderboardExhaustionDeclaration } from '../acquisition-exhaustion'
import { hasRegisteredLeaderboardMetricTrust } from '../serving/metric-trust-publish'
import { OKX_LEADERBOARD_EXHAUSTION, okxAdapter } from '../adapters/okx'
import { BINANCE_WEB3_LEADERBOARD_EXHAUSTION, binanceWeb3Adapter } from '../adapters/binance-web3'

type Json = Record<string, unknown>
type Answer = { status: number; json: unknown }

const session = { paced: async <T>(fn: () => Promise<T>) => fn() } as unknown as FetchSession

function fixturePages(dir: string, name: string): Json[] {
  const file = join(__dirname, '..', 'adapters', dir, '__tests__', 'fixtures', name)
  return (JSON.parse(readFileSync(file, 'utf8')) as { pages: Json[] }).pages
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

interface ExhaustedCase {
  slug: string
  adapter: SourceAdapter
  adapterSlug: string
  currency: SourceRow['currency']
  timeframe: RankingTimeframe
  pageSize: number
  meta: Record<string, unknown>
  declaration: LeaderboardExhaustionDeclaration
  pages: () => Json[]
  /** Row array of one page. */
  rows: (page: Json) => Json[]
  /** Request page index of a request URL. */
  requestPage: (url: URL) => number
}

const okxRows = (page: Json) => ((page.data as Json[])[0].ranks as Json[]) ?? []
const web3Rows = (page: Json) => (page.data as Json).data as Json[]

const CASES: ExhaustedCase[] = [
  ...(
    [
      ['okx_futures', 'SWAP', 'swap'],
      ['okx_spot', 'SPOT', 'spot'],
    ] as const
  ).map(
    ([slug, instType, file]): ExhaustedCase => ({
      slug,
      adapter: okxAdapter,
      adapterSlug: 'okx',
      currency: 'USDT',
      timeframe: 90,
      pageSize: 20,
      meta: { inst_type: instType },
      declaration: OKX_LEADERBOARD_EXHAUSTION,
      pages: () => fixturePages('okx', `board-capture-${file}.json`),
      rows: okxRows,
      requestPage: (url) => Number(url.searchParams.get('page')),
    })
  ),
  {
    slug: 'binance_web3_bsc',
    adapter: binanceWeb3Adapter,
    adapterSlug: 'binance_web3',
    currency: 'USD',
    timeframe: 90,
    pageSize: 3,
    meta: {},
    declaration: BINANCE_WEB3_LEADERBOARD_EXHAUSTION,
    pages: () => fixturePages('binance-web3', 'board-capture-90d.json'),
    rows: web3Rows,
    requestPage: (url) => Number(url.searchParams.get('pageNo')),
  },
]

function sourceRow(item: ExhaustedCase, meta: Record<string, unknown> = {}): SourceRow {
  return {
    id: 41,
    slug: item.slug,
    exchange_id: 41,
    product_type: item.slug === 'okx_spot' ? 'spot' : 'futures',
    trader_kind_scope: 'human',
    adapter_slug: item.adapterSlug,
    leaderboard_url: null,
    timeframes_native: [item.timeframe],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: null,
    deep_profile_topn: 0,
    positions_topn: 0,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'none',
    currency: item.currency,
    page_size: item.pageSize,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'local',
    rate_budget_ms: 0,
    phase: 2,
    serving_mode: 'serving',
    status: 'active',
    meta: { ...item.meta, ...meta },
  }
}

/**
 * Serve `pages` by request page index; `reread` (when given) answers the
 * second request for page one.
 */
async function capture(
  item: ExhaustedCase,
  pages: Json[],
  options: { reread?: Json; meta?: Record<string, unknown> } = {}
): Promise<{ capture: LeaderboardCapture; urls: URL[] }> {
  const urls: URL[] = []
  const originalFetch = global.fetch
  global.fetch = (async (input: string | URL) => {
    const url = new URL(String(input))
    urls.push(url)
    const index = item.requestPage(url)
    const seenPageOne = urls.filter((seen) => item.requestPage(seen) === 1).length
    const body =
      index === 1 && seenPageOne > 1 && options.reread ? options.reread : pages[index - 1]
    const answer: Answer = body ? { status: 200, json: body } : { status: 404, json: null }
    return { status: answer.status, json: async () => answer.json } as Response
  }) as unknown as typeof fetch
  try {
    const result = await item.adapter.captureLeaderboard!(
      session,
      sourceRow(item, options.meta),
      item.timeframe
    )
    return { capture: result as LeaderboardCapture, urls }
  } finally {
    global.fetch = originalFetch
  }
}

function evidence(item: ExhaustedCase, result: LeaderboardCapture) {
  const src = sourceRow(item)
  const ctx = {
    sourceSlug: src.slug,
    currency: src.currency,
    tfLabelMap: src.tf_label_map,
    scrapedAt: new Date().toISOString(),
    meta: src.meta,
  }
  const parsed = result.parsePages.flatMap(
    (page) => item.adapter.parseLeaderboard(page.payload, ctx).rows
  )
  const validated = validateLeaderboardRows(parsed)
  return {
    validated,
    result: attemptBoundEvidenceForCapture({
      capture: result,
      source: src,
      timeframe: item.timeframe,
      acceptedPopulation: validated.valid.length,
      rejectedRowCount: validated.rejects.length,
      registeredExhaustion: item.declaration,
    }),
  }
}

describe.each(CASES)('$slug exhausted capture', (item) => {
  it('binds the complete board as attempt-bound exhausted evidence', async () => {
    const pages = item.pages()
    const { capture: result } = await capture(item, pages)
    const { validated, result: bound } = evidence(item, result)

    const upstreamRows = pages.flatMap(item.rows).length
    expect(validated.valid).toHaveLength(upstreamRows)
    expect(result.completeness?.row_keys).toEqual({
      observed: upstreamRows,
      distinct: upstreamRows,
      duplicate: 0,
    })
    expect(bound).toMatchObject({ completenessMode: 'exhausted', trustBound: true })
    expect(bound.projection).toMatchObject({
      populationState: 'unknown',
      exhaustionVerified: true,
    })
    expect(hasRegisteredLeaderboardMetricTrust(sourceRow(item), item.timeframe)).toBe(true)
    // RAW is the upstream response verbatim and carries no request header.
    expect(result.sourcePages.map((page) => page.rawPage.payload)).toEqual(pages)
    expect(JSON.stringify(result.sourcePages)).not.toContain('user-agent')
  })

  it('refuses a board truncated before its reported page count', async () => {
    const { capture: result } = await capture(item, item.pages(), { meta: { max_pages: 1 } })
    expect(result.terminationReason).toBe('caller_limit')
    expect(evidence(item, result).result.trustBound).toBe(false)
  })

  it('refuses a board whose rows repeat across pages', async () => {
    const pages = item.pages()
    const repeated = clone(item.rows(pages[0])[0])
    item.rows(pages[1])[0] = repeated
    const { capture: result } = await capture(item, pages)
    const { validated, result: bound } = evidence(item, result)
    expect(result.completeness?.row_keys.duplicate).toBe(1)
    expect(validated.valid).toHaveLength(pages.flatMap(item.rows).length - 1)
    expect(bound.trustBound).toBe(false)
  })

  it('refuses a board that is not the registered declaration', async () => {
    const { capture: result } = await capture(item, item.pages())
    const bound = attemptBoundEvidenceForCapture({
      capture: result,
      source: sourceRow(item),
      timeframe: item.timeframe,
      acceptedPopulation: result.completeness!.row_keys.distinct,
      rejectedRowCount: 0,
      registeredExhaustion: { ...item.declaration, max_duplicate_rows: 1 },
    })
    expect(bound.trustBound).toBe(false)
  })

  it('records an anti-bot answer as an upstream error, never an empty board', async () => {
    const pages = item.pages()
    pages[1] = { code: item.slug === 'binance_web3_bsc' ? '000000' : '0', data: null }
    await expect(capture(item, pages)).rejects.toBeInstanceOf(LeaderboardCaptureUpstreamError)
  })
})

describe('okx dataVer board version', () => {
  const okx = CASES[0]

  it('pins page one dataVer on every later request and persists it in RAW', async () => {
    const pages = okx.pages()
    const { capture: result, urls } = await capture(okx, pages)
    const dataVer = (pages[0].data as Json[])[0].dataVer as string
    expect(urls.map((url) => url.searchParams.get('dataVer'))).toEqual([null, dataVer])
    expect(result.sourcePages[1].rawPage.url).toContain(`dataVer=${dataVer}`)
    expect(result.terminationReason).toBe('reported_page_count_reached')
  })

  it('refuses a board whose version shifts between pages', async () => {
    const pages = okx.pages()
    ;(pages[1].data as Json[])[0].dataVer = '20261116070001'
    const { capture: result } = await capture(okx, pages)
    expect(evidence(okx, result).result.trustBound).toBe(false)
  })

  it('refuses the derived 7d/30d boards', async () => {
    await expect(okx.adapter.captureLeaderboard!(session, sourceRow(okx), 30)).rejects.toThrow(
      'derived'
    )
  })
})

describe('binance web3 first-page re-read', () => {
  const web3 = CASES[2]

  it('re-reads page one after the last page and binds when it is unchanged', async () => {
    const { capture: result, urls } = await capture(web3, web3.pages())
    expect(urls.map((url) => url.searchParams.get('pageNo'))).toEqual(['1', '2', '1'])
    expect(result.completeness?.board_version).toMatchObject({ kind: 'first_page_reread' })
  })

  it('refuses a board that moved while it was paged', async () => {
    const pages = web3.pages()
    const moved = clone(pages[0])
    web3Rows(moved).reverse()
    const { capture: result } = await capture(web3, pages, { reread: moved })
    expect(evidence(web3, result).result.trustBound).toBe(false)
  })

  it('flags KOL rows from the row tags', async () => {
    const { capture: result } = await capture(web3, web3.pages())
    const { validated } = evidence(web3, result)
    const kol = validated.valid.filter((row) => row.traderMeta?.binance_web3_kol === true)
    expect(kol.map((row) => row.exchangeTraderId)).toEqual([
      String(web3Rows(web3.pages()[0])[0].address),
    ])
  })
})
