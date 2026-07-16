import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import {
  DataExportReadError,
  DataExportTooLargeError,
  fetchAllExportRows,
  MAX_EXPORT_ROWS_PER_DATASET,
} from '../data-export'

type Page = { data: unknown[] | null; error: unknown }

function fakeClient(pages: Page[]) {
  const calls: Array<{
    table: string
    selection?: string
    ownerColumn?: string
    userId?: string
    cursor?: string
  }> = []
  let pageIndex = 0

  const client = {
    from(table: string) {
      const call: (typeof calls)[number] = { table }
      calls.push(call)
      const query = {
        select: (selection: string) => {
          call.selection = selection
          return query
        },
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
  } as unknown as SupabaseClient<Database>

  return { client, calls }
}

const dataset = {
  name: 'posts',
  table: 'posts',
  ownerColumn: 'author_id',
  selectColumns: ['id'],
}

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
      { table: 'posts', selection: 'id', ownerColumn: 'author_id', userId: 'user-a' },
      {
        table: 'posts',
        selection: 'id',
        ownerColumn: 'author_id',
        userId: 'user-a',
        cursor: '0002',
      },
      {
        table: 'posts',
        selection: 'id',
        ownerColumn: 'author_id',
        userId: 'user-a',
        cursor: '0003',
      },
    ])
  })

  it('projects every row back to the reviewed allowlist', async () => {
    const { client, calls } = fakeClient([
      {
        data: [
          {
            id: '0001',
            stripe_payment_intent_id: 'pi_must_never_escape',
            future_secret: 'must-never-escape',
          },
        ],
        error: null,
      },
      { data: [], error: null },
    ])

    await expect(fetchAllExportRows(client, dataset, 'user-a')).resolves.toEqual([{ id: '0001' }])
    expect(calls.map((call) => call.selection)).toEqual(['id', 'id'])
  })

  it.each([
    'stripe_payment_intent_id',
    'access_token_encrypted',
    'api_key',
    'code_verifier',
    'public_key',
    'endpoint',
    'verification_data',
    'signup_ip_hash',
    'deleted_by',
    'last_error',
  ])('fails before querying when a dataset requests sensitive column %s', async (column) => {
    const { client, calls } = fakeClient([])

    await expect(
      fetchAllExportRows(
        client,
        {
          ...dataset,
          name: 'sensitive-dataset',
          selectColumns: ['id', column],
        },
        'user-a'
      )
    ).rejects.toMatchObject({
      name: 'DataExportReadError',
      dataset: 'sensitive-dataset',
    })
    expect(calls).toHaveLength(0)
  })

  it('fails closed when a selected field is absent from a returned row', async () => {
    const { client } = fakeClient([{ data: [{ id: '0001' }], error: null }])

    await expect(
      fetchAllExportRows(client, { ...dataset, selectColumns: ['id', 'content'] }, 'user-a')
    ).rejects.toBeInstanceOf(DataExportReadError)
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
