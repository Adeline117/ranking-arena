import { IncompleteCrawlError, replayPaged } from '../capture'
import type { JsonFetcher } from '../capture'
import type { FetchSession, ReplayRequestTemplate } from '../types'

/** Minimal paced-only session stub — replay never touches Playwright. */
const session = {
  sourceSlug: 'test',
  paced: <T>(fn: () => Promise<T>) => fn(),
} as unknown as FetchSession

function makeFetcher(pages: Array<{ rows: unknown[]; total?: number }>): JsonFetcher {
  return async (template: ReplayRequestTemplate) => {
    const idx = Number(new URL(template.url).searchParams.get('page')) - 1
    const page = pages[idx] ?? { rows: [] }
    return { status: 200, json: { rows: page.rows, total: page.total ?? null } }
  }
}

const opts = (fetcher: JsonFetcher, pageSize: number | null) => ({
  session,
  fetcher,
  buildRequest: (pageIndex: number) => ({
    url: `https://x.test/api?page=${pageIndex}`,
    method: 'GET' as const,
    headers: {},
  }),
  extractMeta: (payload: unknown) => {
    const p = payload as { rows: unknown[]; total: number | null }
    return { rowCount: p.rows.length, reportedTotal: p.total }
  },
  pageSize,
})

async function collect(gen: AsyncGenerator<{ pageIndex: number }>) {
  const out: number[] = []
  for await (const page of gen) out.push(page.pageIndex)
  return out
}

describe('replayPaged', () => {
  it('walks pages until a short page and yields each', async () => {
    const fetcher = makeFetcher([
      { rows: [1, 2, 3], total: 8 },
      { rows: [4, 5, 6] },
      { rows: [7, 8] }, // short page → stop
    ])
    expect(await collect(replayPaged(opts(fetcher, 3)))).toEqual([1, 2, 3])
  })

  it('stops on an empty page', async () => {
    const fetcher = makeFetcher([{ rows: [1, 2] }, { rows: [] }])
    expect(await collect(replayPaged(opts(fetcher, null)))).toEqual([1])
  })

  it('stops once reportedTotal rows are seen', async () => {
    const fetcher = makeFetcher([
      { rows: [1, 2, 3], total: 6 },
      { rows: [4, 5, 6] },
      { rows: [99, 99, 99] }, // must never be fetched
    ])
    expect(await collect(replayPaged(opts(fetcher, 3)))).toEqual([1, 2])
  })

  it('applies the degenerate-page stop rule without failing completeness', async () => {
    // XT failure mode: source claims 1000 but pages turn all-zero after 2.
    const fetcher = makeFetcher([
      { rows: [1, 2, 3], total: 1000 },
      { rows: [4, 5, 6] },
      { rows: [0, 0, 0] },
      { rows: [0, 0, 0] },
    ])
    const pages = await collect(
      replayPaged({
        ...opts(fetcher, 3),
        isDegenerate: (payload) => (payload as { rows: number[] }).rows.every((r) => r === 0),
      })
    )
    expect(pages).toEqual([1, 2]) // degenerate page not yielded, no throw
  })

  it('ending on an empty page short of total is a natural end (stale total)', async () => {
    // Source claims 9 rows but only 6 exist; empty page 3 is a legitimate
    // end per spec §5.6 (last page short or empty) — count-check at staging
    // catches real shrinkage via the rolling baseline instead.
    const fetcher: JsonFetcher = async (template) => {
      const page = Number(new URL(template.url).searchParams.get('page'))
      if (page <= 2) return { status: 200, json: { rows: [1, 2, 3], total: 9 } }
      return { status: 200, json: { rows: [], total: 9 } }
    }
    expect(await collect(replayPaged(opts(fetcher, 3)))).toEqual([1, 2])
  })

  it('throws IncompleteCrawlError when stopping on a full page short of total', async () => {
    // maxPages cap (or a stuck cursor) ends the crawl while the last page
    // was still full and the total was not reached → truncated crawl.
    const fetcher = makeFetcher([
      { rows: [1, 2, 3], total: 12 },
      { rows: [4, 5, 6] },
      { rows: [7, 8, 9] },
      { rows: [10, 11, 12] },
    ])
    await expect(collect(replayPaged({ ...opts(fetcher, 3), maxPages: 2 }))).rejects.toThrow(
      IncompleteCrawlError
    )
  })
})
