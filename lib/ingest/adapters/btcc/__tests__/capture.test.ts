import { readFileSync } from 'fs'
import { join } from 'path'
import type { SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import '../index'
import { getAdapter } from '../../../core/adapter'

type Board = { code: number; total: number; rows: Array<Record<string, unknown>> }

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'trader-page-p1.json'), 'utf8')
) as Board

const source = {
  id: 23,
  slug: 'btcc_futures',
  adapter_slug: 'btcc',
  currency: 'USDT',
  page_size: 2,
  pagination_kind: 'numeric',
  timeframes_native: [30],
  timeframes_derived: [7, 90],
  tf_label_map: {},
  meta: {},
} as unknown as SourceRow

/** Serve `rows` two per page and record every request body. */
function board(rows: Board['rows']) {
  const bodies: Array<Record<string, unknown>> = []
  const api = {
    post: async (_url: string, options?: { data?: unknown }) => {
      const body = options?.data as Record<string, unknown>
      bodies.push(body)
      const pageNum = body.pageNum as number
      const json: Board = {
        ...fixture,
        total: rows.length,
        rows: rows.slice((pageNum - 1) * 2, pageNum * 2),
      }
      return { status: () => 200, json: async () => json }
    },
  }
  const session = {
    sourceSlug: 'btcc_futures',
    api: async () => api,
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
  return { session, bodies }
}

describe('BTCC leaderboard capture', () => {
  it('requests the board in the tie-stable order on every page', async () => {
    const { session, bodies } = board(fixture.rows.slice(0, 3))

    const capture = await getAdapter('btcc').captureLeaderboard!(session, source, 30)

    expect(bodies).toEqual([
      { nickName: '', sortType: 2, pageNum: 1, pageSize: 2 },
      { nickName: '', sortType: 2, pageNum: 2, pageSize: 2 },
    ])
    expect(capture.terminationReason).toBe('reported_population_reached')
    expect(capture.sourcePages.map((page) => page.sourceRowCount)).toEqual([2, 1])
  })
})
