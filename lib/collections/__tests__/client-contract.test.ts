import {
  readCollectionCreateAcknowledgement,
  readCollectionItemAddAcknowledgement,
  readCollectionListAcknowledgement,
} from '../client-contract'

const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const COLLECTION_ID = '20000000-0000-4000-8000-000000000001'
const ITEM_ROW_ID = '30000000-0000-4000-8000-000000000001'
const ITEM_ID = '40000000-0000-4000-8000-000000000001'

function success(data: Record<string, unknown>) {
  return {
    success: true,
    data,
    meta: { timestamp: '2026-08-03T12:00:00.000Z' },
  }
}

const collection = {
  id: COLLECTION_ID,
  user_id: ACTOR_ID,
  name: 'Signals',
  description: null,
  is_public: false,
  created_at: '2026-08-03T12:00:00.000Z',
  updated_at: '2026-08-03T12:00:00.000Z',
}

const item = {
  id: ITEM_ROW_ID,
  collection_id: COLLECTION_ID,
  item_id: ITEM_ID,
  item_type: 'post',
  note: null,
  added_at: '2026-08-03T12:00:00.000Z',
}

describe('collection client response contracts', () => {
  it('reads an exact viewer-bound collection snapshot', () => {
    expect(
      readCollectionListAcknowledgement(
        success({
          viewerId: ACTOR_ID,
          collections: [{ id: COLLECTION_ID, name: 'Signals', item_count: 2 }],
        }),
        ACTOR_ID
      )
    ).toEqual([{ id: COLLECTION_ID, name: 'Signals', item_count: 2 }])
  })

  it.each([
    [
      'wrong viewer',
      success({
        viewerId: '50000000-0000-4000-8000-000000000001',
        collections: [{ id: COLLECTION_ID, name: 'Signals', item_count: 2 }],
      }),
    ],
    [
      'duplicate identity',
      success({
        viewerId: ACTOR_ID,
        collections: [
          { id: COLLECTION_ID, name: 'Signals', item_count: 2 },
          { id: COLLECTION_ID, name: 'Duplicate', item_count: 0 },
        ],
      }),
    ],
    [
      'extra data',
      success({
        viewerId: ACTOR_ID,
        collections: [{ id: COLLECTION_ID, name: 'Signals', item_count: 2, owner: ACTOR_ID }],
      }),
    ],
    [
      'malformed count',
      success({
        viewerId: ACTOR_ID,
        collections: [{ id: COLLECTION_ID, name: 'Signals', item_count: '2' }],
      }),
    ],
    [
      'extra envelope field',
      {
        ...success({ viewerId: ACTOR_ID, collections: [] }),
        requestId: 'stale',
      },
    ],
  ])('rejects a list with %s', (_label, value) => {
    expect(readCollectionListAcknowledgement(value, ACTOR_ID)).toBeNull()
  })

  it('binds collection creation to actor, collection and requested fields', () => {
    expect(
      readCollectionCreateAcknowledgement(
        success({ action: 'create', actorId: ACTOR_ID, collectionId: COLLECTION_ID, collection }),
        { actorId: ACTOR_ID, name: 'Signals', description: null, isPublic: false }
      )
    ).toEqual(collection)
    expect(
      readCollectionCreateAcknowledgement(
        success({
          action: 'create',
          actorId: ACTOR_ID,
          collectionId: COLLECTION_ID,
          collection: { ...collection, name: 'Other' },
        }),
        { actorId: ACTOR_ID, name: 'Signals', description: null, isPublic: false }
      )
    ).toBeNull()
  })

  it('binds item insertion to actor, collection, post and item type', () => {
    const acknowledgement = success({
      action: 'add',
      actorId: ACTOR_ID,
      collectionId: COLLECTION_ID,
      itemId: ITEM_ID,
      itemType: 'post',
      item,
    })

    expect(
      readCollectionItemAddAcknowledgement(acknowledgement, {
        actorId: ACTOR_ID,
        collectionId: COLLECTION_ID,
        itemId: ITEM_ID,
        itemType: 'post',
      })
    ).toEqual(item)
    expect(
      readCollectionItemAddAcknowledgement(acknowledgement, {
        actorId: ACTOR_ID,
        collectionId: COLLECTION_ID,
        itemId: '50000000-0000-4000-8000-000000000001',
        itemType: 'post',
      })
    ).toBeNull()
    expect(
      readCollectionItemAddAcknowledgement(
        success({
          action: 'add',
          actorId: ACTOR_ID,
          collectionId: COLLECTION_ID,
          itemId: ITEM_ID,
          itemType: 'post',
          item,
          stale: false,
        }),
        {
          actorId: ACTOR_ID,
          collectionId: COLLECTION_ID,
          itemId: ITEM_ID,
          itemType: 'post',
        }
      )
    ).toBeNull()
  })
})
