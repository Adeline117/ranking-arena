/**
 * LBank board capture against the host the site serves today.
 *
 * Live probe 2026-11-15: the board and profile pages call
 * futures-follow-center same-origin under www.lbank.com/lbk-api, and the
 * former uuapi.rerrkvifj.com host answers getAll with
 * {"error_code":10006,"msg":"not open path"}. A capture against the old host
 * is an upstream_error; against the served host the 30D board (198 rows,
 * total 198) bound as complete evidence.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { lbankAdapter } from '..'
import type { SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { isPartitionedNumericLeaderboardCapture } from '../../../fetch/capture'
import { validateLeaderboardRows } from '../../../staging/validate'
import { attemptBoundEvidenceForCapture } from '../../../testing/attempt-bound-evidence'

const SERVED = 'https://www.lbank.com/lbk-api/futures-follow-center/trader/stat/v1/getAll'

function board(): Record<string, unknown> {
  const payload = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'getall-30d-p1.json'), 'utf8')
  ) as { data: Record<string, unknown> & { records: unknown[] } }
  // One complete page: the reported total equals the rows served.
  payload.data.total = payload.data.records.length
  payload.data.pages = 1
  return payload
}

function session(requests: string[]): FetchSession {
  const answer = (url: string) => {
    requests.push(url)
    const json = url.startsWith(`${SERVED}?`)
      ? board()
      : { error_code: 10006, msg: 'not open path', result: 'false', success: false }
    return { status: () => 200, json: async () => json }
  }
  return {
    sourceSlug: 'lbank_futures',
    page: async () => ({ goto: async () => undefined }),
    api: async () => ({
      get: async (url: string) => answer(url),
      post: async (url: string) => answer(url),
    }),
    capture: async () => ({
      first: async () => ({ template: { url: '', method: 'GET', headers: { source: '4' } } }),
      dispose: () => undefined,
    }),
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
}

const src = {
  id: 41,
  slug: 'lbank_futures',
  adapter_slug: 'lbank',
  leaderboard_url: 'https://www.lbank.com/copy-trading?tab=all',
  currency: 'USDT',
  tf_label_map: {},
  page_size: 20,
  pagination_kind: 'numeric',
  meta: {},
} as unknown as SourceRow

describe('lbank captureLeaderboard', () => {
  it('requests the served lbk-api host and binds a complete board', async () => {
    const requests: string[] = []
    const capture = await lbankAdapter.captureLeaderboard!(session(requests), src, 30)
    if (isPartitionedNumericLeaderboardCapture(capture)) throw new Error('identity capture')

    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]).origin + new URL(requests[0]).pathname).toBe(SERVED)
    expect(capture.terminationReason).toBe('reported_population_reached')

    const rows = capture.parsePages.flatMap(
      (page) =>
        lbankAdapter.parseLeaderboard(page.payload, {
          sourceSlug: src.slug,
          currency: 'USDT',
          tfLabelMap: {},
          scrapedAt: '2026-11-15T00:00:00.000Z',
          meta: {},
        }).rows
    )
    const validated = validateLeaderboardRows(rows)
    const evidence = attemptBoundEvidenceForCapture({
      capture,
      source: src,
      timeframe: 30,
      acceptedPopulation: validated.valid.length,
      rejectedRowCount: validated.rejects.length,
    })
    expect(evidence).toMatchObject({ completenessMode: 'reported_total', trustBound: true })
  })

  it('treats the retired host answer as an upstream error, never an empty board', async () => {
    const requests: string[] = []
    const retired = {
      ...src,
      meta: {
        endpoints: {
          list: 'https://uuapi.rerrkvifj.com/futures-follow-center/trader/stat/v1/getAll',
        },
      },
    } as SourceRow
    await expect(lbankAdapter.captureLeaderboard!(session(requests), retired, 30)).rejects.toThrow(
      /not a success answer/
    )
  })
})
