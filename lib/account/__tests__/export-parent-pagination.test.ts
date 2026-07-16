import type { SupabaseClient } from '@supabase/supabase-js'
import type { CursorExportDataset } from '../export-pagination'

const mockFetchAllExportRowsByCursor = jest.fn()

jest.mock('../export-pagination', () => {
  const actual = jest.requireActual('../export-pagination')
  return {
    ...actual,
    MAX_EXPORT_ROWS_PER_DATASET: 3,
    fetchAllExportRowsByCursor: (...args: unknown[]) => mockFetchAllExportRowsByCursor(...args),
  }
})

import { DataExportReadError, DataExportTooLargeError } from '../export-pagination'
import { fetchAllExportRowsForUuidParents } from '../export-parent-pagination'

const parentA = '11111111-1111-4111-8111-111111111111'
const parentB = '22222222-2222-4222-8222-222222222222'

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

const client = {} as SupabaseClient

describe('fetchAllExportRowsForUuidParents', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('validates an empty parent set without issuing child queries', async () => {
    await expect(fetchAllExportRowsForUuidParents(client, dataset, [])).resolves.toEqual([])
    expect(mockFetchAllExportRowsByCursor).not.toHaveBeenCalled()

    await expect(
      fetchAllExportRowsForUuidParents(
        client,
        { ...dataset, selectColumns: ['id', 'access_token_encrypted'] },
        []
      )
    ).rejects.toBeInstanceOf(DataExportReadError)
  })

  it('sorts verified parents and returns only rows bound to each parent', async () => {
    mockFetchAllExportRowsByCursor.mockImplementation(async (_client, _dataset, parentId) => [
      {
        id:
          parentId === parentA
            ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        collection_id: parentId,
        item_type: 'post',
        item_id: `item-${parentId}`,
      },
    ])

    const rows = await fetchAllExportRowsForUuidParents(client, dataset, [parentB, parentA])

    expect(rows.map((row) => row.collection_id)).toEqual([parentA, parentB])
    expect(mockFetchAllExportRowsByCursor.mock.calls.map((call) => call[2])).toEqual([
      parentA,
      parentB,
    ])
  })

  it('rejects duplicate, malformed, or cross-parent keys', async () => {
    await expect(
      fetchAllExportRowsForUuidParents(client, dataset, [parentA, parentA.toUpperCase()])
    ).rejects.toBeInstanceOf(DataExportReadError)
    await expect(
      fetchAllExportRowsForUuidParents(client, dataset, ['not-a-uuid'])
    ).rejects.toBeInstanceOf(DataExportReadError)

    mockFetchAllExportRowsByCursor.mockResolvedValueOnce([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        collection_id: parentB,
        item_type: 'post',
        item_id: 'cross-parent',
      },
    ])
    await expect(
      fetchAllExportRowsForUuidParents(client, dataset, [parentA])
    ).rejects.toBeInstanceOf(DataExportReadError)
  })

  it('shares one total row cap across every parent', async () => {
    mockFetchAllExportRowsByCursor
      .mockResolvedValueOnce([
        { id: '1', collection_id: parentA, item_type: 'post', item_id: 'a' },
        { id: '2', collection_id: parentA, item_type: 'post', item_id: 'b' },
      ])
      .mockResolvedValueOnce([
        { id: '3', collection_id: parentB, item_type: 'post', item_id: 'c' },
        { id: '4', collection_id: parentB, item_type: 'post', item_id: 'd' },
      ])

    await expect(
      fetchAllExportRowsForUuidParents(client, dataset, [parentA, parentB])
    ).rejects.toBeInstanceOf(DataExportTooLargeError)
  })
})
