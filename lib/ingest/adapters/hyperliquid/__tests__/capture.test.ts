/**
 * Hyperliquid board capture over the verbatim stats-data document.
 *
 * Live probe 2026-11-18 (read-only GET of
 * stats-data.hyperliquid.xyz/Mainnet/leaderboard): one 39 MB JSON object
 * { leaderboardRows } with 48,027 rows, all with a distinct lowercase
 * ethAddress and every window value finite; no total, no pagination. The same
 * bytes and ETag come back with `?page=1` and on a re-read 20 s later.
 * leaderboard-board.json keeps 32 of those rows verbatim.
 *
 * The capture stores the document unchanged, parses it per window, and binds
 * only through the registered exhaustion contract: one short page plus an
 * identical re-read. A grown, changed, duplicated or failed document never
 * binds.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { HYPERLIQUID_LEADERBOARD_EXHAUSTION, hyperliquidAdapter } from '..'
import type { RankingTimeframe, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import {
  isPartitionedNumericLeaderboardCapture,
  LeaderboardCaptureUpstreamError,
  type LeaderboardCapture,
} from '../../../fetch/capture'
import { validateLeaderboardRows } from '../../../staging/validate'
import { attemptBoundEvidenceForCapture } from '../../../testing/attempt-bound-evidence'
import { hasRegisteredLeaderboardMetricTrust } from '../../../serving/metric-trust-publish'
import { getRegisteredMetricSourceContract } from '../../../../metric-trust'

const BOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'

type Json = Record<string, unknown>

function board(): { leaderboardRows: Json[] } {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'leaderboard-board.json'), 'utf8')
  ) as { leaderboardRows: Json[] }
}

const session = { paced: async <T>(fn: () => Promise<T>) => fn() } as unknown as FetchSession

const src = {
  id: 20,
  slug: 'hyperliquid',
  adapter_slug: 'hyperliquid',
  currency: 'USDC',
  tf_label_map: {},
  page_size: 250_000,
  pagination_kind: 'numeric',
  meta: {},
} as unknown as SourceRow

interface Answer {
  status: number
  json: unknown
}

let requests: string[]
let answers: Array<() => Answer>
const originalFetch = global.fetch

beforeEach(() => {
  requests = []
  answers = []
  global.fetch = jest.fn(async (input: unknown) => {
    requests.push(String(input))
    const next = answers.shift()
    if (!next) throw new Error('unexpected request')
    const answer = next()
    return { status: answer.status, json: async () => answer.json }
  }) as unknown as typeof fetch
})

afterEach(() => {
  global.fetch = originalFetch
})

function evidence(capture: LeaderboardCapture, timeframe: RankingTimeframe, source = src) {
  const rows = capture.parsePages.flatMap(
    (page) =>
      hyperliquidAdapter.parseLeaderboard(page.payload, {
        sourceSlug: source.slug,
        currency: source.currency,
        tfLabelMap: {},
        scrapedAt: '2026-11-18T19:00:00.000Z',
        meta: {},
        timeframe,
      }).rows
  )
  const validated = validateLeaderboardRows(rows)
  return {
    validated,
    result: attemptBoundEvidenceForCapture({
      capture,
      source,
      timeframe,
      acceptedPopulation: validated.valid.length,
      rejectedRowCount: validated.rejects.length,
      registeredExhaustion: HYPERLIQUID_LEADERBOARD_EXHAUSTION,
    }),
  }
}

async function capture(timeframe: RankingTimeframe = 7, source = src) {
  const result = await hyperliquidAdapter.captureLeaderboard!(session, source, timeframe)
  if (isPartitionedNumericLeaderboardCapture(result)) throw new Error('identity capture')
  return result
}

describe('hyperliquid captureLeaderboard', () => {
  it.each([7, 30] as const)(
    '%sd: the verbatim document binds as a complete exhausted board',
    async (timeframe) => {
      answers.push(() => ({ status: 200, json: board() }))
      answers.push(() => ({ status: 200, json: board() }))

      const result = await capture(timeframe)

      // the board, then the exhaustion re-read; both ask for page 1 only
      expect(requests).toEqual([`${BOARD_URL}?page=1`, `${BOARD_URL}?page=1`])
      expect(result.terminationReason).toBe('short_page')
      expect(result.sourcePages).toHaveLength(1)
      expect(result.parsePages).toHaveLength(1)
      // stored unchanged: no window, no truncation, no wrapper
      expect(result.parsePages[0].payload).toEqual(board())
      expect(result.parsePages[0].url).toBe(`${BOARD_URL}?page=1`)
      expect(result.sourcePages[0].sourceRowCount).toBe(32)

      const { validated, result: bound } = evidence(result, timeframe)
      expect(validated.rejects).toHaveLength(0)
      expect(validated.valid).toHaveLength(32)
      expect(bound).toMatchObject({
        completenessMode: 'exhausted',
        trustBound: true,
        reason: null,
      })
    }
  )

  it('a document that changed before the re-read never binds', async () => {
    const changed = board()
    changed.leaderboardRows.reverse()
    answers.push(() => ({ status: 200, json: board() }))
    answers.push(() => ({ status: 200, json: changed }))

    const { result } = evidence(await capture(), 7)
    expect(result.trustBound).toBe(false)
  })

  it('a failed re-read leaves the board unproven', async () => {
    answers.push(() => ({ status: 200, json: board() }))
    answers.push(() => ({ status: 503, json: null }))

    const { result } = evidence(await capture(), 7)
    expect(result.trustBound).toBe(false)
  })

  it('a duplicated address never binds', async () => {
    const duplicated = board()
    duplicated.leaderboardRows.push({ ...duplicated.leaderboardRows[0] })
    answers.push(() => ({ status: 200, json: duplicated }))
    answers.push(() => ({ status: 200, json: duplicated }))

    const { result } = evidence(await capture(), 7)
    expect(result.trustBound).toBe(false)
  })

  it('a document at the page-size ceiling stops after one request and never binds', async () => {
    const small = { ...src, page_size: 32 } as SourceRow
    answers.push(() => ({ status: 200, json: board() }))

    const result = await capture(7, small)
    expect(requests).toHaveLength(1)
    expect(result.terminationReason).toBe('safety_limit')
    expect(evidence(result, 7, small).result.trustBound).toBe(false)
  })

  it('an HTTP failure is a durable upstream error, never an empty board', async () => {
    answers.push(() => ({ status: 500, json: { message: 'internal' } }))

    const error = await capture().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LeaderboardCaptureUpstreamError)
    expect((error as LeaderboardCaptureUpstreamError).status).toBe(500)
  })

  it('a response without leaderboardRows is an upstream error', async () => {
    answers.push(() => ({ status: 200, json: { error: 'not found' } }))

    await expect(capture()).rejects.toThrow('leaderboard response must contain leaderboardRows')
  })

  it('refuses a source that is not configured for the capture before any request', async () => {
    await expect(capture(7, { ...src, page_size: null } as SourceRow)).rejects.toThrow(
      'requires sources.page_size'
    )
    await expect(
      capture(7, { ...src, pagination_kind: 'api_cursor' } as SourceRow)
    ).rejects.toThrow('requires numeric sources.pagination_kind')
    expect(requests).toHaveLength(0)
  })

  it('listLeaderboard yields the captured document', async () => {
    answers.push(() => ({ status: 200, json: board() }))
    answers.push(() => ({ status: 200, json: board() }))

    const pages = []
    for await (const page of hyperliquidAdapter.listLeaderboard(session, src, 30)) pages.push(page)
    expect(pages).toHaveLength(1)
    expect(pages[0].payload).toEqual(board())
  })
})

describe('hyperliquid board metric contract', () => {
  it('covers exactly the 7D and 30D board windows in USDC', () => {
    expect(hasRegisteredLeaderboardMetricTrust(src, 7)).toBe(true)
    expect(hasRegisteredLeaderboardMetricTrust(src, 30)).toBe(true)
    expect(hasRegisteredLeaderboardMetricTrust(src, 90)).toBe(false)
    expect(hasRegisteredLeaderboardMetricTrust({ ...src, currency: 'USDT' }, 7)).toBe(false)
  })

  it.each([
    [7, '7D'],
    [30, '30D'],
  ] as const)('%sd parser lineage claims are the registered field paths', (timeframe, key) => {
    const contract = getRegisteredMetricSourceContract('hyperliquid')!
    const registered = contract.fields
      .filter((field) => field.windowKeys.includes(key))
      .map((field) => `${field.metric}:${field.fieldPath}`)
      .sort()
    const [row] = hyperliquidAdapter.parseLeaderboard(board(), {
      sourceSlug: 'hyperliquid',
      currency: 'USDC',
      tfLabelMap: {},
      scrapedAt: '2026-11-18T19:00:00.000Z',
      meta: {},
      timeframe,
    }).rows
    const claimed = Object.entries(row.headlineMetricSources ?? {})
      .map(([metric, source]) => `${metric}:${source!.fieldPath}`)
      .sort()
    expect(claimed).toEqual(registered)
  })
})
