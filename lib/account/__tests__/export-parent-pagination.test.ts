import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import type { CursorExportDataset } from '../export-pagination'

jest.mock('../export-pagination', () => {
  const actual = jest.requireActual('../export-pagination')
  return {
    ...actual,
    // Keep global-cap tests small. The batch reader receives this remaining
    // budget explicitly, so its production paging path is still exercised.
    MAX_EXPORT_ROWS_PER_DATASET: 3,
  }
})

import { DataExportReadError, DataExportTooLargeError } from '../export-pagination'
import {
  EXPORT_PARENT_KEY_BATCH_SIZE,
  fetchAllExportRowsForUuidParents,
  MAX_EXPORT_PARENT_KEYS,
} from '../export-parent-pagination'

type Page = { data: unknown[] | null; error: unknown }

type QueryCall = {
  table: string
  selection?: string
  owners?: { column: string; values: readonly unknown[] }
  orders: Array<{ column: string; ascending: boolean | undefined }>
  limit?: number
  or?: string
  equalsCalls: number
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
        orders: [],
        equalsCalls: 0,
        rangeCalls: 0,
        offsetCalls: 0,
      }
      calls.push(call)
      const query = {
        select: (selection: string) => {
          call.selection = selection
          return query
        },
        in: (column: string, values: readonly unknown[]) => {
          call.owners = { column, values: [...values] }
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
        or: (filter: string) => {
          call.or = filter
          return query
        },
        // These exist only to prove this path cannot fall back to one-owner or
        // truncating offset/range pagination.
        eq: () => {
          call.equalsCalls += 1
          return query
        },
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
  } as unknown as SupabaseClient<Database>

  return { client, calls }
}

function uuid(index: number, prefix = '00000000'): string {
  return `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

function itemRow(parent: string, id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    collection_id: parent,
    item_type: 'post',
    item_id: `post-${id}`,
    ...extra,
  }
}

const parentA = uuid(1)
const parentB = uuid(2)
const childA = uuid(1, '10000000')
const childB = uuid(2, '10000000')
const childC = uuid(3, '10000000')
const childD = uuid(4, '10000000')

const dataset = {
  name: 'collections.items',
  table: 'collection_items',
  selectColumns: ['id', 'collection_id', 'item_type', 'item_id'],
  ownerPredicate: { column: 'collection_id', operator: 'eq', valueType: 'uuid' },
  cursor: {
    order: 'asc',
    columns: [{ column: 'id', valueType: 'uuid' }],
  },
} satisfies CursorExportDataset

describe('fetchAllExportRowsForUuidParents', () => {
  it('validates an empty parent set without issuing child queries', async () => {
    const { client, calls } = fakeClient([])

    await expect(fetchAllExportRowsForUuidParents(client, dataset, [])).resolves.toEqual([])
    expect(calls).toHaveLength(0)

    await expect(
      fetchAllExportRowsForUuidParents(
        client,
        { ...dataset, selectColumns: ['id', 'access_token_encrypted'] },
        []
      )
    ).rejects.toBeInstanceOf(DataExportReadError)
    await expect(
      fetchAllExportRowsForUuidParents(client, { ...dataset, table: 'unsafe-table' }, [])
    ).rejects.toBeInstanceOf(DataExportReadError)
    expect(calls).toHaveLength(0)
  })

  it('batches sorted parents and fully keyset-pages each batch, including short pages', async () => {
    const parents = Array.from({ length: EXPORT_PARENT_KEY_BATCH_SIZE + 1 }, (_, index) =>
      uuid(index + 1)
    )
    const lastFirstBatchParent = parents[EXPORT_PARENT_KEY_BATCH_SIZE - 1]
    const secondBatchParent = parents[EXPORT_PARENT_KEY_BATCH_SIZE]
    const { client, calls } = fakeClient([
      { data: [itemRow(parentA.toUpperCase(), childA)], error: null },
      { data: [itemRow(lastFirstBatchParent, childB)], error: null },
      { data: [], error: null },
      { data: [itemRow(secondBatchParent, childC)], error: null },
      { data: [], error: null },
    ])

    const rows = await fetchAllExportRowsForUuidParents(client, dataset, [...parents].reverse())

    expect(rows.map((row) => row.collection_id)).toEqual([
      parentA,
      lastFirstBatchParent,
      secondBatchParent,
    ])
    expect(calls).toHaveLength(5)
    expect(calls.map(({ owners }) => owners?.values.length)).toEqual([
      EXPORT_PARENT_KEY_BATCH_SIZE,
      EXPORT_PARENT_KEY_BATCH_SIZE,
      EXPORT_PARENT_KEY_BATCH_SIZE,
      1,
      1,
    ])
    expect(calls[0].owners).toEqual({ column: 'collection_id', values: parents.slice(0, 100) })
    expect(calls[0].orders).toEqual([
      { column: 'collection_id', ascending: true },
      { column: 'id', ascending: true },
    ])
    expect(calls[0].or).toBeUndefined()
    expect(calls[1].or).toBe(
      `collection_id.gt.${parentA},and(collection_id.eq.${parentA},id.gt.${childA})`
    )
    expect(calls[2].or).toBe(
      `collection_id.gt.${lastFirstBatchParent},` +
        `and(collection_id.eq.${lastFirstBatchParent},id.gt.${childB})`
    )
    expect(calls[3].or).toBeUndefined()
    expect(
      calls.every(
        ({ equalsCalls, rangeCalls, offsetCalls }) =>
          equalsCalls === 0 && rangeCalls === 0 && offsetCalls === 0
      )
    ).toBe(true)
  })

  it('keeps every UUID filter below the fixed URL-safe batch bound', async () => {
    const parents = Array.from({ length: EXPORT_PARENT_KEY_BATCH_SIZE * 2 + 1 }, (_, index) =>
      uuid(index + 1)
    )
    const { client, calls } = fakeClient([
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ])

    await expect(fetchAllExportRowsForUuidParents(client, dataset, parents)).resolves.toEqual([])

    expect(calls.map(({ owners }) => owners?.values.length)).toEqual([100, 100, 1])
    for (const call of calls) {
      const values = call.owners?.values as string[]
      expect(values.join(',').length).toBeLessThanOrEqual(3_699)
    }
  })

  it('rejects duplicate, malformed, excessive, and incompatible parent keys', async () => {
    const { client, calls } = fakeClient([])

    await expect(
      fetchAllExportRowsForUuidParents(client, dataset, [parentA, parentA.toUpperCase()])
    ).rejects.toBeInstanceOf(DataExportReadError)
    await expect(
      fetchAllExportRowsForUuidParents(client, dataset, ['not-a-uuid'])
    ).rejects.toBeInstanceOf(DataExportReadError)
    await expect(
      fetchAllExportRowsForUuidParents(
        client,
        dataset,
        Array.from({ length: MAX_EXPORT_PARENT_KEYS + 1 }, (_, index) => uuid(index + 1))
      )
    ).rejects.toBeInstanceOf(DataExportTooLargeError)
    await expect(
      fetchAllExportRowsForUuidParents(
        client,
        {
          ...dataset,
          cursor: {
            order: 'asc',
            columns: [{ column: 'collection_id', valueType: 'uuid' }],
          },
        },
        [parentA]
      )
    ).rejects.toBeInstanceOf(DataExportReadError)
    expect(calls).toHaveLength(0)
  })

  it('fails closed when a row escapes the verified parent batch', async () => {
    const { client } = fakeClient([{ data: [itemRow(parentB, childA)], error: null }])

    await expect(
      fetchAllExportRowsForUuidParents(client, dataset, [parentA])
    ).rejects.toBeInstanceOf(DataExportReadError)
  })

  it('fails closed on repeated, stalled, or out-of-order cursor tuples', async () => {
    const repeated = fakeClient([
      { data: [itemRow(parentA, childA)], error: null },
      { data: [itemRow(parentA, childA)], error: null },
    ])
    const childOrderRegressed = fakeClient([
      { data: [itemRow(parentA, childB), itemRow(parentA, childA)], error: null },
    ])
    const parentOrderRegressed = fakeClient([
      { data: [itemRow(parentB, childA), itemRow(parentA, childB)], error: null },
    ])

    for (const { client } of [repeated, childOrderRegressed, parentOrderRegressed]) {
      await expect(
        fetchAllExportRowsForUuidParents(client, dataset, [parentA, parentB])
      ).rejects.toBeInstanceOf(DataExportReadError)
    }
  })

  it('keeps parent ordering strict while deferring text-key ordering to PostgreSQL collation', async () => {
    const textCursorDataset = {
      ...dataset,
      cursor: {
        order: 'asc',
        columns: [{ column: 'item_id', valueType: 'string' }],
      },
    } satisfies CursorExportDataset
    const collated = fakeClient([
      {
        // This may be valid under a locale-aware PostgreSQL collation even
        // though JavaScript compares these UTF-16 strings differently.
        data: [
          itemRow(parentA, childA, { item_id: 'ä' }),
          itemRow(parentA, childB, { item_id: 'z' }),
        ],
        error: null,
      },
      { data: [], error: null },
    ])
    await expect(
      fetchAllExportRowsForUuidParents(collated.client, textCursorDataset, [parentA])
    ).resolves.toHaveLength(2)

    const parentRegressed = fakeClient([
      {
        data: [
          itemRow(parentB, childA, { item_id: 'a' }),
          itemRow(parentA, childB, { item_id: 'z' }),
        ],
        error: null,
      },
    ])
    await expect(
      fetchAllExportRowsForUuidParents(parentRegressed.client, textCursorDataset, [
        parentA,
        parentB,
      ])
    ).rejects.toBeInstanceOf(DataExportReadError)
  })

  it('requires every selected column, strips extras, and preserves reviewed text casts', async () => {
    const missing = fakeClient([
      {
        data: [{ id: childA, collection_id: parentA, item_type: 'post' }],
        error: null,
      },
    ])
    await expect(
      fetchAllExportRowsForUuidParents(missing.client, dataset, [parentA])
    ).rejects.toBeInstanceOf(DataExportReadError)

    const numericDataset = {
      ...dataset,
      selectColumns: [...dataset.selectColumns, 'exact_amount'],
      textCastColumns: ['exact_amount'],
    } satisfies CursorExportDataset
    const exact = fakeClient([
      {
        data: [
          itemRow(parentA, childA, {
            exact_amount: '1234567890.123456789',
            future_secret: 'must-not-escape',
          }),
        ],
        error: null,
      },
      { data: [], error: null },
    ])
    await expect(
      fetchAllExportRowsForUuidParents(exact.client, numericDataset, [parentA])
    ).resolves.toEqual([
      {
        ...itemRow(parentA, childA),
        exact_amount: '1234567890.123456789',
      },
    ])
    expect(exact.calls[0].selection).toContain('exact_amount::text')

    const inexact = fakeClient([
      { data: [itemRow(parentA, childA, { exact_amount: 123.45 })], error: null },
    ])
    await expect(
      fetchAllExportRowsForUuidParents(inexact.client, numericDataset, [parentA])
    ).rejects.toBeInstanceOf(DataExportReadError)
  })

  it('shares one exact row cap across all pages and batches', async () => {
    const { client, calls } = fakeClient([
      {
        data: [itemRow(parentA, childA), itemRow(parentA, childB), itemRow(parentA, childC)],
        error: null,
      },
      { data: [itemRow(parentA, childD)], error: null },
    ])

    await expect(
      fetchAllExportRowsForUuidParents(client, dataset, [parentA])
    ).rejects.toBeInstanceOf(DataExportTooLargeError)
    expect(calls.map(({ limit }) => limit)).toEqual([4, 1])
  })

  it('fails the entire child dataset on malformed results or query failures', async () => {
    const malformed = fakeClient([{ data: null, error: null }])
    const databaseError = { code: 'XX001', message: 'read failed' }
    const failed = fakeClient([{ data: null, error: databaseError }])
    const thrown = fakeClient([new Error('network failed')])

    await expect(
      fetchAllExportRowsForUuidParents(malformed.client, dataset, [parentA])
    ).rejects.toBeInstanceOf(DataExportReadError)
    await expect(
      fetchAllExportRowsForUuidParents(failed.client, dataset, [parentA])
    ).rejects.toMatchObject({ causeValue: databaseError })
    await expect(
      fetchAllExportRowsForUuidParents(thrown.client, dataset, [parentA])
    ).rejects.toBeInstanceOf(DataExportReadError)
  })
})
