/**
 * GMX attempt-bound board capture (manifest v3, exhausted mode).
 *
 * Live probe 2026-11-18 (gmx.squids.live, read-only): periodAccountStats
 * honours limit/offset (no orderBy), returns the whole completed-day window
 * in one unsorted response (7d/30d/90d: 2,516 / 3,274 / 4,920 accounts),
 * answers the same ids and values on repeat, ignores the `extensions` map,
 * and echoes the `arenaWindow_…: __typename` alias. board-capture-7d.json is
 * that 7d response trimmed to 12 rows; the capture binds it as a short page
 * re-read once for stability.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  GMX_LEADERBOARD_EXHAUSTION,
  GMX_LEADERBOARD_PAGE_SIZE,
  GMX_SUBGRAPH_URL,
  buildGmxLeaderboardRequestBody,
  gmxAdapter,
  projectGmxLeaderboardRequest,
} from '../index'
import type { SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { LeaderboardCaptureUpstreamError, type LeaderboardCapture } from '../../../fetch/capture'
import { validateLeaderboardRows } from '../../../staging/validate'
import { attemptBoundEvidenceForCapture } from '../../../testing/attempt-bound-evidence'

type Json = Record<string, unknown>

/** Inside the fixture's window: 2026-11-18T05:00Z → to = 1794960000. */
const NOW = Date.parse('2026-11-18T05:00:00.000Z')
const WINDOW = { from: 1794355200, to: 1794960000 }

function board(): Json {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'board-capture-7d.json'), 'utf8')
  ) as Json
}

const rowsOf = (payload: Json) => (payload.data as Json).periodAccountStats as Json[]

const session = { paced: async <T>(fn: () => Promise<T>) => fn() } as unknown as FetchSession

const src = {
  id: 32,
  slug: 'gmx',
  adapter_slug: 'gmx',
  leaderboard_url: 'https://app.gmx.io/#/leaderboard',
  currency: 'USDC',
  tf_label_map: {},
  timeframes_native: [7, 30, 90],
  page_size: GMX_LEADERBOARD_PAGE_SIZE,
  pagination_kind: 'numeric',
  meta: {},
} as unknown as SourceRow

interface Sent {
  url: string
  init: RequestInit
  body: { query: string; extensions: { arenaPage: number } }
}

/** Answer each request in order; requests past the list repeat the last answer. */
async function capture(
  answers: Array<{ status: number; json: unknown }>,
  source: SourceRow = src
): Promise<{ capture: LeaderboardCapture; sent: Sent[] }> {
  const sent: Sent[] = []
  const originalFetch = global.fetch
  global.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) })
    const answer = answers[Math.min(sent.length, answers.length) - 1]
    return { status: answer.status, json: async () => answer.json } as Response
  }) as unknown as typeof fetch
  try {
    const result = await gmxAdapter.captureLeaderboard!(session, source, 7)
    return { capture: result as LeaderboardCapture, sent }
  } finally {
    global.fetch = originalFetch
  }
}

function evidence(result: LeaderboardCapture) {
  const parsed = result.parsePages.flatMap(
    (page) =>
      gmxAdapter.parseLeaderboard(page.payload, {
        sourceSlug: 'gmx',
        currency: 'USDC',
        tfLabelMap: {},
        scrapedAt: '2026-11-18T05:00:00.000Z',
        meta: {},
      }).rows
  )
  const validated = validateLeaderboardRows(parsed)
  return {
    validated,
    bound: attemptBoundEvidenceForCapture({
      capture: result,
      source: src,
      timeframe: 7,
      acceptedPopulation: validated.valid.length,
      rejectedRowCount: validated.rejects.length,
      registeredExhaustion: GMX_LEADERBOARD_EXHAUSTION,
    }),
  }
}

describe('gmx captureLeaderboard', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW))
  afterEach(() => jest.restoreAllMocks())

  it('binds the whole window as one short page re-read once', async () => {
    const payload = board()
    const { capture: result, sent } = await capture([{ status: 200, json: payload }])

    // Board request + first-page re-read, both for the same exact window.
    expect(sent).toHaveLength(2)
    for (const request of sent) {
      expect(request.url).toBe(GMX_SUBGRAPH_URL)
      expect(request.init.method).toBe('POST')
      expect(request.body).toEqual(
        buildGmxLeaderboardRequestBody({
          timeframe: 7,
          ...WINDOW,
          pageIndex: 1,
          pageSize: GMX_LEADERBOARD_PAGE_SIZE,
        })
      )
      expect(request.body.query).toContain(`limit: ${GMX_LEADERBOARD_PAGE_SIZE}, offset: 0`)
      expect(request.body.query).toContain(`from: ${WINDOW.from}, to: ${WINDOW.to}`)
    }

    expect(result.terminationReason).toBe('short_page')
    expect(result.sourcePages).toHaveLength(1)
    // RAW is the upstream response verbatim; the public URL carries no query.
    expect(result.sourcePages[0].rawPage.payload).toEqual(payload)
    expect(result.sourcePages[0].rawPage.url).toBe(GMX_SUBGRAPH_URL)
    expect(result.completeness?.row_keys).toEqual({ observed: 12, distinct: 12, duplicate: 0 })
    expect(result.completeness?.board_version).toMatchObject({ kind: 'first_page_reread' })

    const { validated, bound } = evidence(result)
    expect(validated.valid).toHaveLength(rowsOf(payload).length)
    expect(validated.rejects).toHaveLength(0)
    expect(bound).toMatchObject({ completenessMode: 'exhausted', trustBound: true })
    expect(bound.projection).toMatchObject({ exhaustionVerified: true })
  })

  it('refuses a board that moved between the read and the re-read', async () => {
    const moved = board()
    rowsOf(moved).reverse()
    const { capture: result } = await capture([
      { status: 200, json: board() },
      { status: 200, json: moved },
    ])
    expect(evidence(result).bound.trustBound).toBe(false)
  })

  it('refuses a full first page: the population may continue past the limit', async () => {
    const full = { ...src, page_size: GMX_LEADERBOARD_PAGE_SIZE } as SourceRow
    const payload = board()
    const rows = rowsOf(payload)
    ;(payload.data as Json).periodAccountStats = Array.from(
      { length: GMX_LEADERBOARD_PAGE_SIZE },
      (_, index) => ({
        ...rows[index % rows.length],
        id: `0x${index.toString(16).padStart(40, '0')}`,
      })
    )
    const { capture: result, sent } = await capture([{ status: 200, json: payload }], full)
    expect(sent).toHaveLength(1)
    expect(result.terminationReason).toBe('caller_limit')
    expect(evidence(result).bound.trustBound).toBe(false)
  })

  it('records GraphQL errors and a foreign window as upstream errors, never an empty board', async () => {
    const errored = { errors: [{ message: 'from should be rounded to 00:00:00' }], data: null }
    await expect(capture([{ status: 200, json: errored }])).rejects.toBeInstanceOf(
      LeaderboardCaptureUpstreamError
    )

    const foreign = board()
    const data = foreign.data as Json
    delete data.arenaWindow_7d_1794355200_1794960000
    data.arenaWindow_7d_1793750400_1794355200 = 'Query'
    await expect(capture([{ status: 200, json: foreign }])).rejects.toThrow(
      'echoes a different window'
    )

    await expect(capture([{ status: 503, json: null }])).rejects.toBeInstanceOf(
      LeaderboardCaptureUpstreamError
    )
  })

  it('requires the reviewed page size before any request', async () => {
    const sent: unknown[] = []
    const originalFetch = global.fetch
    global.fetch = (async (...args: unknown[]) => {
      sent.push(args)
      throw new Error('no request expected')
    }) as unknown as typeof fetch
    try {
      await expect(
        gmxAdapter.captureLeaderboard!(session, { ...src, page_size: 20 } as SourceRow, 7)
      ).rejects.toThrow('page_size 50000')
    } finally {
      global.fetch = originalFetch
    }
    expect(sent).toHaveLength(0)
  })
})

describe('gmx leaderboard public request projection', () => {
  it('keeps exactly the GraphQL document and the page ordinal', () => {
    const body = buildGmxLeaderboardRequestBody({
      timeframe: 30,
      from: 1792368000,
      to: 1794960000,
      pageIndex: 2,
      pageSize: 10,
    })
    expect(body.query).toContain('arenaWindow_30d_1792368000_1794960000: __typename')
    expect(body.query).toContain('limit: 10, offset: 10')
    expect(projectGmxLeaderboardRequest({ method: 'POST', url: GMX_SUBGRAPH_URL, body })).toEqual({
      method: 'POST',
      url: GMX_SUBGRAPH_URL,
      body,
    })
    expect(() =>
      projectGmxLeaderboardRequest({
        method: 'POST',
        url: GMX_SUBGRAPH_URL,
        body: { ...body, variables: {} },
      })
    ).toThrow('exactly { query, extensions }')
    expect(() =>
      projectGmxLeaderboardRequest({ method: 'POST', url: `${GMX_SUBGRAPH_URL}?x=1`, body })
    ).toThrow('query parameters')
  })
})
