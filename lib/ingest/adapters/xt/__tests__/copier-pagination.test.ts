import type { RawPage, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { CopierPageCapReachedError } from '../../../core/history-page-cap'
import { xtAdapter } from '../index'

const src = {
  id: 11,
  slug: 'xt_futures',
  adapter_slug: 'xt',
  currency: 'USDT',
  tf_label_map: {},
  meta: { history_max_pages: 2, history_page_size: 2 },
} as unknown as SourceRow

function session(pageFor: (pageNo: number) => unknown): FetchSession {
  const get = async (url: string) => ({
    status: () => 200,
    json: async () => pageFor(Number(new URL(url).searchParams.get('page'))),
  })
  return {
    sourceSlug: src.slug,
    api: async () => ({ get }),
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
}

const followers = (pageNo: number, count: number, hasNext: boolean) => ({
  returnCode: 0,
  msgInfo: 'success',
  error: null,
  result: {
    hasNext,
    items: Array.from({ length: count }, (_, i) => ({
      accountId: pageNo * 100 + i,
      followerName: `f${pageNo}-${i}`,
    })),
  },
})

async function collect(
  stream: AsyncIterable<RawPage>
): Promise<{ pages: RawPage[]; error: unknown }> {
  const pages: RawPage[] = []
  try {
    for await (const page of stream) pages.push(page)
    return { pages, error: null }
  } catch (error) {
    return { pages, error }
  }
}

const copiers = (fetchSession: FetchSession) =>
  collect(xtAdapter.getHistory(fetchSession, src, 'leader-1', 'copiers', null))

describe('xt copier pagination', () => {
  it('raises CopierPageCapReachedError when the budget ends while the source has more', async () => {
    const { pages, error } = await copiers(session((p) => followers(p, 2, true)))
    expect(pages).toHaveLength(2)
    expect(error).toBeInstanceOf(CopierPageCapReachedError)
    expect(error).toMatchObject({ sourceSlug: 'xt_futures', pageCap: 2 })
  })

  it('ends quietly when the source reports no next page', async () => {
    const { pages, error } = await copiers(session((p) => followers(p, p === 1 ? 2 : 1, p === 1)))
    expect(error).toBeNull()
    expect(pages).toHaveLength(2)
  })

  it('fails on a business error instead of treating it as an empty follower list', async () => {
    const { pages, error } = await copiers(
      session(() => ({ returnCode: 1, msgInfo: 'busy', error: { code: 'x' }, result: null }))
    )
    expect(pages).toHaveLength(0)
    expect(String(error)).toMatch(/non-success API envelope/)
  })
})
