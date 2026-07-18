const mockFilterPosts = jest.fn()

jest.mock('@/lib/data/service-post-audience', () => ({
  filterServiceReadablePostRows: (...args: unknown[]) => mockFilterPosts(...args),
}))

import {
  filterServiceReadableCollectionItems,
  MAX_COLLECTION_AUDIENCE_ITEMS,
  rebindServiceReadableCollectionItems,
} from '../public-audience'

const COLLECTION_ID = '10000000-0000-4000-8000-000000000001'
const POST_ID = '20000000-0000-4000-8000-000000000001'
const HIDDEN_POST_ID = '20000000-0000-4000-8000-000000000002'
const ACTIVITY_ID = '30000000-0000-4000-8000-000000000001'
const HIDDEN_ACTIVITY_ID = '30000000-0000-4000-8000-000000000002'
const ACTOR_ID = '40000000-0000-4000-8000-000000000001'

function item(id: string, itemType: string, itemId: string) {
  return { id, collection_id: COLLECTION_ID, item_type: itemType, item_id: itemId }
}

describe('collection item public audience', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFilterPosts.mockImplementation(async (_client, rows: Array<{ id: string }>) =>
      rows.filter((row) => row.id === POST_ID)
    )
  })

  it('preserves order while releasing only canonically readable post and activity refs', async () => {
    const rpc = jest.fn(async (_name: string, args: { p_activity_id: string }) => ({
      data: args.p_activity_id === ACTIVITY_ID,
      error: null,
    }))
    const rows = [
      item('item-1', 'activity', ACTIVITY_ID),
      item('item-2', 'post', HIDDEN_POST_ID),
      item('item-3', 'post', POST_ID),
      item('item-4', 'activity', HIDDEN_ACTIVITY_ID),
    ]

    await expect(
      filterServiceReadableCollectionItems({ rpc } as never, rows, ACTOR_ID)
    ).resolves.toEqual([rows[0], rows[2]])
    expect(mockFilterPosts).toHaveBeenCalledWith(
      expect.anything(),
      [{ id: HIDDEN_POST_ID }, { id: POST_ID }],
      ACTOR_ID
    )
    expect(rpc).toHaveBeenCalledWith('can_service_actor_read_activity', {
      p_activity_id: ACTIVITY_ID,
      p_actor_id: ACTOR_ID,
    })
  })

  it.each([
    ['database error', { data: null, error: new Error('offline') }],
    ['malformed acknowledgement', { data: 'yes', error: null }],
  ])('fails an activity closed for a %s', async (_label, result) => {
    const rpc = jest.fn().mockResolvedValue(result)

    await expect(
      filterServiceReadableCollectionItems({ rpc } as never, [
        item('item-1', 'activity', ACTIVITY_ID),
      ])
    ).resolves.toEqual([])
  })

  it('drops malformed ids and unsupported legacy item types without an audience call', async () => {
    const rpc = jest.fn()

    await expect(
      filterServiceReadableCollectionItems({ rpc } as never, [
        item('item-1', 'activity', 'not-a-uuid'),
        item('item-2', 'trader', POST_ID),
      ])
    ).resolves.toEqual([])
    expect(rpc).not.toHaveBeenCalled()
    expect(mockFilterPosts).toHaveBeenCalledWith(expect.anything(), [], null)
  })

  it('fails closed before audience RPCs when a caller exceeds the hard candidate cap', async () => {
    const rpc = jest.fn()
    const rows = Array.from({ length: MAX_COLLECTION_AUDIENCE_ITEMS + 1 }, (_, index) =>
      item(`item-${index}`, 'post', POST_ID)
    )

    await expect(
      filterServiceReadableCollectionItems({ rpc } as never, rows, ACTOR_ID)
    ).rejects.toThrow(
      `Collection audience candidate limit exceeded (${MAX_COLLECTION_AUDIENCE_ITEMS})`
    )
    expect(mockFilterPosts).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('collection item current-row rebinding', () => {
  it('returns the current row and current note for the exact audience-approved identity', () => {
    const approved = {
      ...item('item-1', 'post', POST_ID),
      note: 'stale note',
      added_at: '2026-01-01T00:00:00.000Z',
    }
    const current = {
      ...approved,
      note: 'current note',
      added_at: '2026-01-02T00:00:00.000Z',
    }

    expect(rebindServiceReadableCollectionItems([approved], [current])).toEqual([current])
  })

  it.each([
    ['removed', []],
    [
      'moved to another collection',
      [{ ...item('item-1', 'post', POST_ID), collection_id: ACTOR_ID }],
    ],
    ['retargeted after authorization', [{ ...item('item-1', 'post', HIDDEN_POST_ID) }]],
    ['changed to another resource type', [{ ...item('item-1', 'activity', POST_ID) }]],
  ])('drops an item that was %s before the final read', (_label, current) => {
    const approved = item('item-1', 'post', POST_ID)

    expect(rebindServiceReadableCollectionItems([approved], current)).toEqual([])
  })

  it('preserves the audience-approved order instead of database IN-query order', () => {
    const first = item('item-1', 'post', POST_ID)
    const second = item('item-2', 'activity', ACTIVITY_ID)

    expect(rebindServiceReadableCollectionItems([first, second], [second, first])).toEqual([
      first,
      second,
    ])
  })
})
