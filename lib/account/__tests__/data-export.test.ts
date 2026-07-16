import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DataExportReadError,
  DataExportTooLargeError,
  fetchAllExportRows,
  MAX_EXPORT_ROWS_PER_DATASET,
} from '../data-export'

type Page = { data: unknown[] | null; error: unknown }

function fakeClient(pages: Page[]) {
  const calls: Array<{ table: string; ownerColumn?: string; userId?: string; cursor?: string }> = []
  let pageIndex = 0

  const client = {
    from(table: string) {
      const call: (typeof calls)[number] = { table }
      calls.push(call)
      const query = {
        select: () => query,
        eq: (column: string, value: string) => {
          call.ownerColumn = column
          call.userId = value
          return query
        },
        order: () => query,
        limit: () => query,
        gt: (_column: string, value: string) => {
          call.cursor = value
          return query
        },
        then: (resolve: (page: Page) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(pages[pageIndex++]).then(resolve, reject),
      }
      return query
    },
  } as unknown as SupabaseClient

  return { client, calls }
}

const dataset = { name: 'posts', table: 'posts', ownerColumn: 'author_id' }

describe('fetchAllExportRows', () => {
  it('keeps paging after short non-empty server pages and binds every page to the owner', async () => {
    const { client, calls } = fakeClient([
      { data: [{ id: '0001' }, { id: '0002' }], error: null },
      { data: [{ id: '0003' }], error: null },
      { data: [], error: null },
    ])

    await expect(fetchAllExportRows(client, dataset, 'user-a')).resolves.toEqual([
      { id: '0001' },
      { id: '0002' },
      { id: '0003' },
    ])
    expect(calls).toEqual([
      { table: 'posts', ownerColumn: 'author_id', userId: 'user-a' },
      { table: 'posts', ownerColumn: 'author_id', userId: 'user-a', cursor: '0002' },
      { table: 'posts', ownerColumn: 'author_id', userId: 'user-a', cursor: '0003' },
    ])
  })

  it('fails the entire dataset when any page errors', async () => {
    const databaseError = { code: 'XX001', message: 'page failed' }
    const { client } = fakeClient([
      { data: [{ id: '0001' }], error: null },
      { data: null, error: databaseError },
    ])

    await expect(fetchAllExportRows(client, dataset, 'user-a')).rejects.toMatchObject({
      name: 'DataExportReadError',
      dataset: 'posts',
      causeValue: databaseError,
    })
  })

  it.each([
    [[{ value: 'missing-id' }], 'missing id'],
    [[{ id: '0002' }, { id: '0001' }], 'non-monotonic ids'],
  ])('rejects malformed page rows (%s: %s)', async (data) => {
    const { client } = fakeClient([{ data, error: null }])

    await expect(fetchAllExportRows(client, dataset, 'user-a')).rejects.toBeInstanceOf(
      DataExportReadError
    )
  })

  it('returns an explicit too-large failure instead of a partial successful export', async () => {
    const oversizedPage = new Array(MAX_EXPORT_ROWS_PER_DATASET + 1).fill({ id: '0001' })
    const { client } = fakeClient([{ data: oversizedPage, error: null }])

    await expect(fetchAllExportRows(client, dataset, 'user-a')).rejects.toBeInstanceOf(
      DataExportTooLargeError
    )
  })
})
