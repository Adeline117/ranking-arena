import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type CursorExportDataset,
  DataExportReadError,
  fetchAllExportRowsByCursor,
  EXPORT_PAGE_SIZE,
} from '../export-pagination'

type Page = { data: unknown[] | null; error: unknown }

type QueryCall = {
  table: string
  selection?: string
  equals: Array<{ column: string; value: unknown }>
  orders: Array<{ column: string; ascending: boolean | undefined }>
  limit?: number
  greaterThan?: { column: string; value: unknown }
  or?: string
  rangeCalls: number
  offsetCalls: number
}

function fakeClient(pages: Array<Page | Error>) {
  const calls: QueryCall[] = []
  let pageIndex = 0

  const client = {
    from(table: string) {
      const call: QueryCall = {
        table,
        equals: [],
        orders: [],
        rangeCalls: 0,
        offsetCalls: 0,
      }
      calls.push(call)
      const query = {
        select: (selection: string) => {
          call.selection = selection
          return query
        },
        eq: (column: string, value: unknown) => {
          call.equals.push({ column, value })
          return query
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          call.orders.push({ column, ascending: options?.ascending })
          return query
        },
        limit: (limit: number) => {
          call.limit = limit
          return query
        },
        gt: (column: string, value: unknown) => {
          call.greaterThan = { column, value }
          return query
        },
        or: (filter: string) => {
          call.or = filter
          return query
        },
        // These methods exist only to prove that the helper never reaches for
        // truncating range/offset pagination.
        range: () => {
          call.rangeCalls += 1
          return query
        },
        offset: () => {
          call.offsetCalls += 1
          return query
        },
        then: (resolve: (page: Page) => unknown, reject: (error: unknown) => unknown) => {
          const page = pages[pageIndex++]
          return (page instanceof Error ? Promise.reject(page) : Promise.resolve(page)).then(
            resolve,
            reject
          )
        },
      }
      return query
    },
  } as unknown as SupabaseClient

  return { client, calls }
}

const stringIdDataset = {
  name: 'string-ids',
  table: 'string_records',
  selectColumns: ['id', 'payload'],
  ownerPredicate: { column: 'user_id', operator: 'eq', valueType: 'string' },
  cursor: {
    order: 'asc',
    columns: [{ column: 'id', valueType: 'string' }],
  },
} satisfies CursorExportDataset

const createdAtIdDataset = {
  name: 'created-at-id',
  table: 'events',
  selectColumns: ['created_at', 'id', 'payload'],
  ownerPredicate: { column: 'user_id', operator: 'eq', valueType: 'uuid' },
  cursor: {
    order: 'asc',
    columns: [
      { column: 'created_at', valueType: 'timestamp' },
      { column: 'id', valueType: 'uuid' },
    ],
  },
} satisfies CursorExportDataset

const ownerUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const firstUuid = '00000000-0000-0000-0000-000000000001'
const secondUuid = '00000000-0000-0000-0000-000000000002'

describe('fetchAllExportRowsByCursor', () => {
  it('reads more than 1000 rows by keyset and never uses range or offset', async () => {
    const firstPage = Array.from({ length: EXPORT_PAGE_SIZE }, (_, index) => ({
      id: String(index + 1).padStart(4, '0'),
      payload: index,
    }))
    const secondPage = Array.from({ length: 7 }, (_, index) => ({
      id: String(EXPORT_PAGE_SIZE + index + 1).padStart(4, '0'),
      payload: EXPORT_PAGE_SIZE + index,
    }))
    const { client, calls } = fakeClient([
      { data: firstPage, error: null },
      { data: secondPage, error: null },
      { data: [], error: null },
    ])

    const rows = await fetchAllExportRowsByCursor(client, stringIdDataset, 'user-a')

    expect(rows).toHaveLength(EXPORT_PAGE_SIZE + 7)
    expect(rows.at(-1)).toEqual({ id: '1007', payload: 1006 })
    expect(calls).toHaveLength(3)
    expect(calls.map(({ limit }) => limit)).toEqual([1000, 1000, 1000])
    expect(calls[1].greaterThan).toEqual({ column: 'id', value: '1000' })
    expect(calls[2].greaterThan).toEqual({ column: 'id', value: '1007' })
    expect(
      calls.every(({ rangeCalls, offsetCalls }) => rangeCalls === 0 && offsetCalls === 0)
    ).toBe(true)
  })

  it('continues after every short non-empty server page until an empty page proves completion', async () => {
    const { client, calls } = fakeClient([
      {
        data: [
          { id: 'a', payload: 1 },
          { id: 'b', payload: 2 },
        ],
        error: null,
      },
      { data: [{ id: 'c', payload: 3 }], error: null },
      { data: [], error: null },
    ])

    await expect(fetchAllExportRowsByCursor(client, stringIdDataset, 'user-a')).resolves.toEqual([
      { id: 'a', payload: 1 },
      { id: 'b', payload: 2 },
      { id: 'c', payload: 3 },
    ])
    expect(calls).toHaveLength(3)
  })

  it('supports canonical UUID keysets', async () => {
    const uuidDataset = {
      ...stringIdDataset,
      name: 'uuid-ids',
      cursor: {
        order: 'asc',
        columns: [{ column: 'id', valueType: 'uuid' }],
      },
    } satisfies CursorExportDataset
    const { client, calls } = fakeClient([
      {
        data: [
          { id: firstUuid.toUpperCase(), payload: 1 },
          { id: secondUuid, payload: 2 },
        ],
        error: null,
      },
      { data: [], error: null },
    ])

    await expect(fetchAllExportRowsByCursor(client, uuidDataset, 'user-a')).resolves.toEqual([
      { id: firstUuid, payload: 1 },
      { id: secondUuid, payload: 2 },
    ])
    expect(calls[1].greaterThan).toEqual({ column: 'id', value: secondUuid })
  })

  it('casts bigint cursors to text before JSON parsing and preserves int8 precision end to end', async () => {
    const bigintDataset = {
      ...stringIdDataset,
      name: 'bigint-ids',
      cursor: {
        order: 'asc',
        columns: [{ column: 'id', valueType: 'bigint' }],
      },
    } satisfies CursorExportDataset
    const { client, calls } = fakeClient([
      {
        data: [
          { id: '9007199254740993', payload: 'above-number-safe-range' },
          { id: 9223372036854775807n, payload: 'postgres-max' },
        ],
        error: null,
      },
      { data: [], error: null },
    ])

    await expect(fetchAllExportRowsByCursor(client, bigintDataset, 'user-a')).resolves.toEqual([
      { id: '9007199254740993', payload: 'above-number-safe-range' },
      { id: '9223372036854775807', payload: 'postgres-max' },
    ])
    expect(calls.map(({ selection }) => selection)).toEqual([
      'id::text,payload',
      'id::text,payload',
    ])
    expect(calls[1].greaterThan).toEqual({ column: 'id', value: '9223372036854775807' })
  })

  it.each([42, Number('9007199254740993')])(
    'rejects bigint cursor number %s because JSON may already have rounded it',
    async (id) => {
      const bigintDataset = {
        ...stringIdDataset,
        cursor: {
          order: 'asc',
          columns: [{ column: 'id', valueType: 'bigint' }],
        },
      } satisfies CursorExportDataset
      const { client } = fakeClient([{ data: [{ id, payload: null }], error: null }])

      await expect(
        fetchAllExportRowsByCursor(client, bigintDataset, 'user-a')
      ).rejects.toBeInstanceOf(DataExportReadError)
    }
  )

  it('builds a stable (created_at, id) lexicographic cursor with microsecond timestamps', async () => {
    const firstTimestamp = '2026-07-16T09:00:00.123456Z'
    const secondTimestamp = '2026-07-16T09:00:00.123457Z'
    const { client, calls } = fakeClient([
      {
        data: [
          { created_at: firstTimestamp, id: firstUuid, payload: 1 },
          { created_at: firstTimestamp, id: secondUuid, payload: 2 },
        ],
        error: null,
      },
      { data: [{ created_at: secondTimestamp, id: firstUuid, payload: 3 }], error: null },
      { data: [], error: null },
    ])

    await expect(
      fetchAllExportRowsByCursor(client, createdAtIdDataset, ownerUuid)
    ).resolves.toHaveLength(3)
    expect(calls[0].orders).toEqual([
      { column: 'created_at', ascending: true },
      { column: 'id', ascending: true },
    ])
    expect(calls[1].or).toBe(
      `created_at.gt."${firstTimestamp}",` +
        `and(created_at.eq."${firstTimestamp}",id.gt.${secondUuid})`
    )
    expect(calls[2].or).toBe(
      `created_at.gt."${secondTimestamp}",` +
        `and(created_at.eq."${secondTimestamp}",id.gt.${firstUuid})`
    )
  })

  it('supports a real composite primary key without an id column', async () => {
    const compositePrimaryKeyDataset = {
      name: 'reading-progress',
      table: 'reading_progress',
      selectColumns: ['user_id', 'book_id', 'progress'],
      ownerPredicate: { column: 'user_id', operator: 'eq', valueType: 'string' },
      cursor: {
        order: 'asc',
        columns: [
          { column: 'user_id', valueType: 'string' },
          { column: 'book_id', valueType: 'string' },
        ],
      },
    } satisfies CursorExportDataset
    const { client, calls } = fakeClient([
      {
        data: [
          { user_id: 'user-a', book_id: 'book-a', progress: 20 },
          { user_id: 'user-a', book_id: 'book-b', progress: 50 },
        ],
        error: null,
      },
      { data: [], error: null },
    ])

    await expect(
      fetchAllExportRowsByCursor(client, compositePrimaryKeyDataset, 'user-a')
    ).resolves.toEqual([
      { user_id: 'user-a', book_id: 'book-a', progress: 20 },
      { user_id: 'user-a', book_id: 'book-b', progress: 50 },
    ])
    expect(calls[1].or).toBe('user_id.gt.user-a,and(user_id.eq.user-a,book_id.gt.book-b)')
  })

  it('escapes reserved PostgREST grammar characters in string cursors', async () => {
    const { client, calls } = fakeClient([
      { data: [{ id: 'record"),other.eq.secret\\tail', payload: null }], error: null },
      { data: [], error: null },
    ])

    await expect(
      fetchAllExportRowsByCursor(client, stringIdDataset, 'user-a')
    ).resolves.toHaveLength(1)
    expect(calls[1].greaterThan).toEqual({
      column: 'id',
      value: '"record\\"),other.eq.secret\\\\tail"',
    })
  })

  it('defers text ordering to PostgreSQL collation while still completing the keyset', async () => {
    const { client, calls } = fakeClient([
      {
        // Under locale-aware database collations, this can be a valid ascending
        // order even though JavaScript compares the UTF-16 code units differently.
        data: [
          { id: 'ä', payload: 1 },
          { id: 'z', payload: 2 },
        ],
        error: null,
      },
      { data: [], error: null },
    ])

    await expect(fetchAllExportRowsByCursor(client, stringIdDataset, 'user-a')).resolves.toEqual([
      { id: 'ä', payload: 1 },
      { id: 'z', payload: 2 },
    ])
    expect(calls[1].greaterThan).toEqual({ column: 'id', value: 'z' })
  })

  it('fails closed when a database-collated text cursor tuple repeats', async () => {
    const { client } = fakeClient([
      { data: [{ id: 'ä', payload: 1 }], error: null },
      { data: [{ id: 'ä', payload: 2 }], error: null },
    ])

    await expect(
      fetchAllExportRowsByCursor(client, stringIdDataset, 'user-a')
    ).rejects.toMatchObject({
      name: 'DataExportReadError',
      dataset: 'string-ids',
    })
  })

  it('fails closed when a composite cursor repeats instead of advancing', async () => {
    const row = {
      created_at: '2026-07-16T09:00:00.123456Z',
      id: firstUuid,
      payload: null,
    }
    const { client } = fakeClient([
      { data: [row], error: null },
      { data: [row], error: null },
    ])

    await expect(
      fetchAllExportRowsByCursor(client, createdAtIdDataset, ownerUuid)
    ).rejects.toMatchObject({
      name: 'DataExportReadError',
      dataset: 'created-at-id',
    })
  })

  it('fails closed when any explicitly selected field is missing', async () => {
    const { client } = fakeClient([{ data: [{ id: 'a' }], error: null }])

    await expect(
      fetchAllExportRowsByCursor(client, stringIdDataset, 'user-a')
    ).rejects.toBeInstanceOf(DataExportReadError)
  })

  it('projects rows back to selectColumns even if the server returns extra fields', async () => {
    const { client } = fakeClient([
      {
        data: [{ id: 'a', payload: 1, future_secret: 'must-not-escape' }],
        error: null,
      },
      { data: [], error: null },
    ])

    await expect(fetchAllExportRowsByCursor(client, stringIdDataset, 'user-a')).resolves.toEqual([
      { id: 'a', payload: 1 },
    ])
  })

  it.each([
    ['missing selectColumns', { ...stringIdDataset, selectColumns: undefined }],
    ['missing owner predicate', { ...stringIdDataset, ownerPredicate: undefined }],
    ['missing cursor', { ...stringIdDataset, cursor: undefined }],
    [
      'cursor field not selected',
      {
        ...stringIdDataset,
        cursor: { order: 'asc', columns: [{ column: 'created_at', valueType: 'timestamp' }] },
      },
    ],
    [
      'duplicate cursor field',
      {
        ...stringIdDataset,
        cursor: {
          order: 'asc',
          columns: [
            { column: 'id', valueType: 'string' },
            { column: 'id', valueType: 'string' },
          ],
        },
      },
    ],
    [
      'unsafe selected field',
      { ...stringIdDataset, selectColumns: ['id', 'access_token_encrypted'] },
    ],
  ])('rejects malformed descriptor: %s', async (_caseName, malformedDataset) => {
    const { client, calls } = fakeClient([])

    await expect(
      fetchAllExportRowsByCursor(
        client,
        malformedDataset as unknown as CursorExportDataset,
        'user-a'
      )
    ).rejects.toBeInstanceOf(DataExportReadError)
    expect(calls).toHaveLength(0)
  })

  it('fails the entire dataset on a page error or thrown query failure', async () => {
    const databaseError = { code: 'XX001', message: 'read failed' }
    const first = fakeClient([{ data: null, error: databaseError }])
    const second = fakeClient([new Error('network failed')])

    await expect(
      fetchAllExportRowsByCursor(first.client, stringIdDataset, 'user-a')
    ).rejects.toMatchObject({ causeValue: databaseError })
    await expect(
      fetchAllExportRowsByCursor(second.client, stringIdDataset, 'user-a')
    ).rejects.toMatchObject({
      name: 'DataExportReadError',
      dataset: 'string-ids',
    })
  })
})
