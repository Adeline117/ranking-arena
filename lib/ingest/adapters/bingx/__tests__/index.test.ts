/**
 * bingx records are harvested from the browser's first page only (the sign
 * covers the query, so deeper pages cannot be replayed). A first page that
 * does not provably cover the whole surface must surface as a page-cap cut,
 * never as a complete history / copier snapshot.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import type { HistoryKind, RawPage, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import {
  CopierPageCapReachedError,
  HistoryPageCapReachedError,
} from '../../../core/history-page-cap'
import { bingxAdapter } from '../index'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const src = {
  id: 21,
  slug: 'bingx_futures',
  product_type: 'futures',
  meta: {},
} as unknown as SourceRow

function session(responseJson: unknown): FetchSession {
  const locator = { first: () => ({ click: async () => undefined }) }
  return {
    sourceSlug: src.slug,
    page: async () => ({
      goto: async () => null,
      evaluate: async () => undefined,
      getByText: () => locator,
    }),
    capture: async () => ({ first: async () => ({ responseJson }), dispose: () => undefined }),
  } as unknown as FetchSession
}

async function drain(
  kind: HistoryKind,
  payload: unknown
): Promise<{ pages: RawPage[]; error: unknown }> {
  const pages: RawPage[] = []
  try {
    for await (const page of bingxAdapter.getHistory(session(payload), src, 'uid-1', kind, null, {
      bingx_api_identity: 'api-1',
    })) {
      pages.push(page)
    }
    return { pages, error: null }
  } catch (error) {
    return { pages, error }
  }
}

describe('bingx first-page record harvest', () => {
  it('flags trades as cut when the reported total exceeds the first page', async () => {
    // Captured fixture: 10 rows on page 1, total 11.
    const { pages, error } = await drain('orders', fixture('records-history-order.json'))
    expect(pages).toHaveLength(1)
    expect(error).toBeInstanceOf(HistoryPageCapReachedError)
    expect(error).toMatchObject({ kind: 'orders', pageCap: 1 })
  })

  it('accepts transfers as complete when the first page holds the reported total', async () => {
    // Captured fixture: 1 row, total 1.
    const { pages, error } = await drain('transfers', fixture('records-transfers.json'))
    expect(pages).toHaveLength(1)
    expect(error).toBeNull()
  })

  it('flags a page without a reported total as cut', async () => {
    const { error } = await drain('transfers', { code: 0, data: { result: [] } })
    expect(error).toBeInstanceOf(HistoryPageCapReachedError)
  })

  it('never presents the copier first page as a complete snapshot', async () => {
    const { pages, error } = await drain('copiers', fixture('records-followers.json'))
    expect(pages).toHaveLength(1)
    expect(error).toBeInstanceOf(CopierPageCapReachedError)
  })
})
