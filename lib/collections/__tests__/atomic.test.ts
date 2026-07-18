import { parseCollectionItemMutationAck, parseCollectionMutationAck } from '../atomic'

const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const COLLECTION_ID = '20000000-0000-4000-8000-000000000001'
const ITEM_ROW_ID = '30000000-0000-4000-8000-000000000001'
const ITEM_ID = '40000000-0000-4000-8000-000000000001'

const collection = {
  id: COLLECTION_ID,
  user_id: ACTOR_ID,
  name: 'Signals',
  description: null,
  is_public: true,
  created_at: '2026-07-16T00:00:00.000Z',
  updated_at: '2026-07-16T00:00:00.000Z',
}

const item = {
  id: ITEM_ROW_ID,
  collection_id: COLLECTION_ID,
  item_id: ITEM_ID,
  item_type: 'post',
  note: null,
  added_at: '2026-07-16T00:00:00.000Z',
}

describe('collection atomic acknowledgements', () => {
  it('accepts an exact collection update acknowledgement bound to actor and resource', () => {
    expect(
      parseCollectionMutationAck(
        {
          action: 'update',
          actor_id: ACTOR_ID,
          applied: true,
          collection,
          collection_id: COLLECTION_ID,
          result_code: 'updated',
        },
        { action: 'update', actorId: ACTOR_ID, collectionId: COLLECTION_ID }
      )
    ).toMatchObject({ applied: true, collection })
  })

  it('accepts an exact not-found acknowledgement but never treats it as applied', () => {
    expect(
      parseCollectionMutationAck(
        {
          action: 'delete',
          actor_id: ACTOR_ID,
          applied: false,
          collection: null,
          collection_id: COLLECTION_ID,
          result_code: 'not_found',
        },
        { action: 'delete', actorId: ACTOR_ID, collectionId: COLLECTION_ID }
      )
    ).toMatchObject({ applied: false, result_code: 'not_found' })
  })

  it.each([
    ['create', 'already_exists', null],
    ['update', 'not_found', COLLECTION_ID],
    ['delete', 'inactive_actor', COLLECTION_ID],
  ] as const)(
    'accepts the canonical non-applied %s acknowledgement %s',
    (action, resultCode, collectionId) => {
      expect(
        parseCollectionMutationAck(
          {
            action,
            actor_id: ACTOR_ID,
            applied: false,
            collection: null,
            collection_id: collectionId,
            result_code: resultCode,
          },
          {
            action,
            actorId: ACTOR_ID,
            collectionId: action === 'create' ? undefined : COLLECTION_ID,
          }
        )
      ).toMatchObject({ applied: false, result_code: resultCode })
    }
  )

  it('accepts an exact item insertion acknowledgement', () => {
    expect(
      parseCollectionItemMutationAck(
        {
          action: 'add',
          actor_id: ACTOR_ID,
          applied: true,
          collection_id: COLLECTION_ID,
          item,
          item_id: ITEM_ID,
          item_type: 'post',
          result_code: 'inserted',
        },
        {
          action: 'add',
          actorId: ACTOR_ID,
          collectionId: COLLECTION_ID,
          itemId: ITEM_ID,
          itemType: 'post',
        }
      )
    ).toMatchObject({ applied: true, item })
  })

  it.each([
    ['add', 'already_exists'],
    ['add', 'collection_not_found'],
    ['add', 'resource_not_found'],
    ['remove', 'collection_not_found'],
    ['remove', 'not_found'],
    ['remove', 'inactive_actor'],
  ] as const)(
    'accepts the canonical non-applied item %s acknowledgement %s',
    (action, resultCode) => {
      expect(
        parseCollectionItemMutationAck(
          {
            action,
            actor_id: ACTOR_ID,
            applied: false,
            collection_id: COLLECTION_ID,
            item: null,
            item_id: ITEM_ID,
            item_type: 'post',
            result_code: resultCode,
          },
          {
            action,
            actorId: ACTOR_ID,
            collectionId: COLLECTION_ID,
            itemId: ITEM_ID,
            itemType: 'post',
          }
        )
      ).toMatchObject({ applied: false, result_code: resultCode })
    }
  )

  it.each([
    ['extra keys', { debug: true }],
    ['wrong actor', { actor_id: '50000000-0000-4000-8000-000000000001' }],
    ['wrong scope', { collection_id: '50000000-0000-4000-8000-000000000001' }],
    ['false success', { applied: false }],
    ['missing row proof', { collection: null }],
  ])('rejects collection acknowledgements with %s', (_label, override) => {
    expect(() =>
      parseCollectionMutationAck(
        {
          action: 'update',
          actor_id: ACTOR_ID,
          applied: true,
          collection,
          collection_id: COLLECTION_ID,
          result_code: 'updated',
          ...override,
        },
        { action: 'update', actorId: ACTOR_ID, collectionId: COLLECTION_ID }
      )
    ).toThrow('Malformed collection mutation acknowledgement')
  })

  it.each([
    ['create', 'not_found', null],
    ['create', 'updated', null],
    ['update', 'already_exists', COLLECTION_ID],
    ['update', 'deleted', COLLECTION_ID],
    ['delete', 'already_exists', COLLECTION_ID],
    ['delete', 'created', COLLECTION_ID],
  ] as const)(
    'rejects impossible collection action/result pair %s + %s',
    (action, resultCode, collectionId) => {
      expect(() =>
        parseCollectionMutationAck(
          {
            action,
            actor_id: ACTOR_ID,
            applied: false,
            collection: null,
            collection_id: collectionId,
            result_code: resultCode,
          },
          {
            action,
            actorId: ACTOR_ID,
            collectionId: action === 'create' ? undefined : COLLECTION_ID,
          }
        )
      ).toThrow('Malformed collection mutation acknowledgement')
    }
  )

  it('rejects a failed create acknowledgement bound to an invented collection id', () => {
    expect(() =>
      parseCollectionMutationAck(
        {
          action: 'create',
          actor_id: ACTOR_ID,
          applied: false,
          collection: null,
          collection_id: COLLECTION_ID,
          result_code: 'already_exists',
        },
        { action: 'create', actorId: ACTOR_ID, collectionId: undefined }
      )
    ).toThrow('Malformed collection mutation acknowledgement')
  })

  it('rejects a non-applied collection acknowledgement carrying a stale row', () => {
    expect(() =>
      parseCollectionMutationAck(
        {
          action: 'update',
          actor_id: ACTOR_ID,
          applied: false,
          collection,
          collection_id: COLLECTION_ID,
          result_code: 'not_found',
        },
        { action: 'update', actorId: ACTOR_ID, collectionId: COLLECTION_ID }
      )
    ).toThrow('Malformed collection mutation acknowledgement')
  })

  it.each([
    ['extra keys', { debug: true }],
    ['wrong item', { item_id: '50000000-0000-4000-8000-000000000001' }],
    ['wrong result', { result_code: 'removed' }],
    ['missing row proof', { item: null }],
  ])('rejects item acknowledgements with %s', (_label, override) => {
    expect(() =>
      parseCollectionItemMutationAck(
        {
          action: 'add',
          actor_id: ACTOR_ID,
          applied: true,
          collection_id: COLLECTION_ID,
          item,
          item_id: ITEM_ID,
          item_type: 'post',
          result_code: 'inserted',
          ...override,
        },
        {
          action: 'add',
          actorId: ACTOR_ID,
          collectionId: COLLECTION_ID,
          itemId: ITEM_ID,
          itemType: 'post',
        }
      )
    ).toThrow('Malformed collection item acknowledgement')
  })

  it.each([
    ['add', 'removed'],
    ['add', 'not_found'],
    ['remove', 'inserted'],
    ['remove', 'already_exists'],
    ['remove', 'resource_not_found'],
  ] as const)('rejects impossible item action/result pair %s + %s', (action, resultCode) => {
    expect(() =>
      parseCollectionItemMutationAck(
        {
          action,
          actor_id: ACTOR_ID,
          applied: false,
          collection_id: COLLECTION_ID,
          item: null,
          item_id: ITEM_ID,
          item_type: 'post',
          result_code: resultCode,
        },
        {
          action,
          actorId: ACTOR_ID,
          collectionId: COLLECTION_ID,
          itemId: ITEM_ID,
          itemType: 'post',
        }
      )
    ).toThrow('Malformed collection item acknowledgement')
  })
})
