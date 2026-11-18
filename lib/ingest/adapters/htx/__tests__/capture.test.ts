/**
 * HTX board capture against the origin the board page lands on.
 *
 * Live probe 2026-11-18: futures.htx.com/en-us/copytrading/{futures,spot}
 * 301-redirects to www.htx.com. An in-page fetch from www.htx.com to the old
 * futures.htx.com API host throws "TypeError: Failed to fetch" (its CORS
 * answer carries two Access-Control-Allow-Origin values), so Tier-A captured
 * 0 pages. The same rank endpoint served same-origin on www.htx.com answers
 * code 200 (futures totalNum 515). Fixture rank-futures-www-20261118.json is
 * that live page (3 rows, profitList trimmed).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { htxAdapter, htxLandedOrigin } from '..'
import type { SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { isPartitionedNumericLeaderboardCapture } from '../../../fetch/capture'
import { validateLeaderboardRows } from '../../../staging/validate'
import { attemptBoundEvidenceForCapture } from '../../../testing/attempt-bound-evidence'

const LANDED = 'https://www.htx.com/en-us/copytrading/futures'
const SERVED_RANK = 'https://www.htx.com/-/x/hbg/v1/futures/copytrading/rank'

function board(): Record<string, unknown> {
  const payload = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'rank-futures-www-20261118.json'), 'utf8')
  ) as { data: Record<string, unknown> & { itemList: unknown[] } }
  // One complete page: the reported total equals the rows served.
  payload.data.totalNum = payload.data.itemList.length
  return payload
}

/** Fake browser session: the page lands on `landedUrl`; in-page fetches
 *  succeed only same-origin, as Chromium does for HTX today. */
function session(landedUrl: string, requests: string[], gotos: string[]): FetchSession {
  const page = {
    goto: async (url: string) => {
      gotos.push(url)
    },
    waitForLoadState: async () => undefined,
    url: () => landedUrl,
  }
  return {
    sourceSlug: 'htx_futures',
    page: async () => page,
    pageFetch: async (template: ReplayRequestTemplate) => {
      requests.push(template.url)
      if (new URL(template.url).origin !== new URL(landedUrl).origin) {
        throw new Error('page.evaluate: TypeError: Failed to fetch')
      }
      if (!template.url.startsWith(`${SERVED_RANK}?`)) return { status: 404, json: null }
      return { status: 200, json: board() }
    },
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
}

const src = {
  id: 13,
  slug: 'htx_futures',
  adapter_slug: 'htx',
  // The registry row still points at the pre-redirect host.
  leaderboard_url: 'https://futures.htx.com/en-us/copytrading/futures',
  currency: 'USDT',
  tf_label_map: {},
  page_size: 50,
  pagination_kind: 'numeric',
  meta: { boardKey: 'futures' },
} as unknown as SourceRow

describe('htx captureLeaderboard', () => {
  it('replays the rank endpoint on the landed www.htx.com origin and binds a complete board', async () => {
    const requests: string[] = []
    const gotos: string[] = []
    const capture = await htxAdapter.captureLeaderboard!(session(LANDED, requests, gotos), src, 90)
    if (isPartitionedNumericLeaderboardCapture(capture)) throw new Error('identity capture')

    expect(gotos).toEqual(['https://futures.htx.com/en-us/copytrading/futures'])
    expect(requests).toHaveLength(1)
    const url = new URL(requests[0])
    expect(url.origin + url.pathname).toBe(SERVED_RANK)
    expect(url.searchParams.get('rankType')).toBe('1')
    expect(url.searchParams.get('pageNo')).toBe('1')
    expect(url.searchParams.get('pageSize')).toBe('50')
    expect(capture.terminationReason).toBe('reported_population_reached')

    const rows = capture.parsePages.flatMap(
      (page) =>
        htxAdapter.parseLeaderboard(page.payload, {
          sourceSlug: src.slug,
          currency: 'USDT',
          tfLabelMap: {},
          scrapedAt: '2026-11-18T00:00:00.000Z',
          meta: src.meta,
        }).rows
    )
    expect(rows).toHaveLength(3)
    const validated = validateLeaderboardRows(rows)
    expect(validated.rejects).toHaveLength(0)
    const evidence = attemptBoundEvidenceForCapture({
      capture,
      source: src,
      timeframe: 90,
      acceptedPopulation: validated.valid.length,
      rejectedRowCount: validated.rejects.length,
    })
    expect(evidence).toMatchObject({ completenessMode: 'reported_total', trustBound: true })
  })

  it('reuses the landed origin for profile replays on a warmed session', async () => {
    const requests: string[] = []
    const gotos: string[] = []
    const s = session(LANDED, requests, gotos)
    await htxAdapter.captureLeaderboard!(s, src, 90)
    await htxAdapter.getPositions!(s, src, 'NDMxMjY2NDQ', { user_sign: 'NDMxMjY2NDQ' }).catch(
      () => undefined // fake answers 404 for non-rank paths; only the URL matters here
    )
    expect(gotos).toHaveLength(1)
    expect(requests[1]).toBe(
      'https://www.htx.com/-/x/hbg/v1/futures/copytrading/trader-info/current-positions?userSign=NDMxMjY2NDQ'
    )
  })
})

describe('htxLandedOrigin', () => {
  it('keeps any https htx.com host the page settled on', () => {
    expect(htxLandedOrigin('https://www.htx.com/en-us/copytrading/spot')).toBe(
      'https://www.htx.com'
    )
    expect(htxLandedOrigin('https://futures.htx.com/en-us/copytrading/futures')).toBe(
      'https://futures.htx.com'
    )
  })

  it('falls back to the served www.htx.com origin off-site', () => {
    expect(htxLandedOrigin('about:blank')).toBe('https://www.htx.com')
    expect(htxLandedOrigin('https://evilhtx.com/x')).toBe('https://www.htx.com')
    expect(htxLandedOrigin('http://www.htx.com/')).toBe('https://www.htx.com')
    expect(htxLandedOrigin('not a url')).toBe('https://www.htx.com')
  })
})
