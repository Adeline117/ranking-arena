const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const COLLECTION_ACK_KEYS = [
  'action',
  'actor_id',
  'applied',
  'collection',
  'collection_id',
  'result_code',
] as const
const ITEM_ACK_KEYS = [
  'action',
  'actor_id',
  'applied',
  'collection_id',
  'item',
  'item_id',
  'item_type',
  'result_code',
] as const

export type CollectionMutationAction = 'create' | 'update' | 'delete'
export type CollectionMutationResultCode =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'already_exists'
  | 'not_found'
  | 'inactive_actor'

export type CollectionItemMutationAction = 'add' | 'remove'
export type CollectionItemMutationResultCode =
  | 'inserted'
  | 'removed'
  | 'already_exists'
  | 'collection_not_found'
  | 'not_found'
  | 'resource_not_found'
  | 'inactive_actor'

const COLLECTION_RESULT_CODES_BY_ACTION = {
  create: ['created', 'already_exists', 'inactive_actor'],
  update: ['updated', 'not_found', 'inactive_actor'],
  delete: ['deleted', 'not_found', 'inactive_actor'],
} as const satisfies Record<CollectionMutationAction, readonly CollectionMutationResultCode[]>

const ITEM_RESULT_CODES_BY_ACTION = {
  add: [
    'inserted',
    'already_exists',
    'collection_not_found',
    'resource_not_found',
    'inactive_actor',
  ],
  remove: ['removed', 'collection_not_found', 'not_found', 'inactive_actor'],
} as const satisfies Record<
  CollectionItemMutationAction,
  readonly CollectionItemMutationResultCode[]
>

export type CollectionRow = {
  id: string
  user_id: string
  name: string
  description: string | null
  is_public: boolean | null
  created_at: string | null
  updated_at: string | null
}

export type CollectionItemRow = {
  id: string
  collection_id: string
  item_id: string
  item_type: string
  note: string | null
  added_at: string | null
}

export type CollectionMutationAck = {
  action: CollectionMutationAction
  actor_id: string
  applied: boolean
  collection: CollectionRow | null
  collection_id: string | null
  result_code: CollectionMutationResultCode
}

export type CollectionItemMutationAck = {
  action: CollectionItemMutationAction
  actor_id: string
  applied: boolean
  collection_id: string
  item: CollectionItemRow | null
  item_id: string
  item_type: 'post' | 'activity'
  result_code: CollectionItemMutationResultCode
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
}

function includesString(values: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && values.includes(value)
}

function parseCollection(value: unknown): CollectionRow | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error('Malformed collection mutation acknowledgement')
  if (
    !hasExactKeys(value, [
      'created_at',
      'description',
      'id',
      'is_public',
      'name',
      'updated_at',
      'user_id',
    ]) ||
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.user_id !== 'string' ||
    !UUID_PATTERN.test(value.user_id) ||
    typeof value.name !== 'string' ||
    (value.description !== null && typeof value.description !== 'string') ||
    (value.is_public !== null && typeof value.is_public !== 'boolean') ||
    !isNullableTimestamp(value.created_at) ||
    !isNullableTimestamp(value.updated_at)
  ) {
    throw new Error('Malformed collection mutation acknowledgement')
  }
  return value as CollectionRow
}

function parseItem(value: unknown): CollectionItemRow | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error('Malformed collection item acknowledgement')
  if (
    !hasExactKeys(value, ['added_at', 'collection_id', 'id', 'item_id', 'item_type', 'note']) ||
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.collection_id !== 'string' ||
    !UUID_PATTERN.test(value.collection_id) ||
    typeof value.item_id !== 'string' ||
    !UUID_PATTERN.test(value.item_id) ||
    !['post', 'activity'].includes(String(value.item_type)) ||
    (value.note !== null && typeof value.note !== 'string') ||
    !isNullableTimestamp(value.added_at)
  ) {
    throw new Error('Malformed collection item acknowledgement')
  }
  return value as CollectionItemRow
}

export function parseCollectionMutationAck(
  value: unknown,
  expected: {
    action: CollectionMutationAction
    actorId: string
    collectionId?: string | null
  }
): CollectionMutationAck {
  if (!isRecord(value) || !hasExactKeys(value, COLLECTION_ACK_KEYS)) {
    throw new Error('Malformed collection mutation acknowledgement')
  }

  const collection = parseCollection(value.collection)
  const resultCodes: readonly CollectionMutationResultCode[] =
    COLLECTION_RESULT_CODES_BY_ACTION[expected.action]
  if (
    value.action !== expected.action ||
    value.actor_id !== expected.actorId ||
    typeof value.applied !== 'boolean' ||
    (value.collection_id !== null &&
      (typeof value.collection_id !== 'string' || !UUID_PATTERN.test(value.collection_id))) ||
    !includesString(resultCodes, value.result_code) ||
    (expected.collectionId !== undefined && value.collection_id !== expected.collectionId)
  ) {
    throw new Error('Malformed collection mutation acknowledgement')
  }

  const successCode =
    expected.action === 'create' ? 'created' : expected.action === 'update' ? 'updated' : 'deleted'
  if (
    value.applied !== (value.result_code === successCode) ||
    (value.applied && expected.action !== 'delete' && collection === null) ||
    (!value.applied && collection !== null) ||
    (expected.action === 'delete' && collection !== null) ||
    (collection !== null &&
      (collection.id !== value.collection_id || collection.user_id !== expected.actorId)) ||
    (expected.action === 'create' &&
      (value.applied ? value.collection_id === null : value.collection_id !== null))
  ) {
    throw new Error('Malformed collection mutation acknowledgement')
  }

  return value as CollectionMutationAck
}

export function parseCollectionItemMutationAck(
  value: unknown,
  expected: {
    action: CollectionItemMutationAction
    actorId: string
    collectionId: string
    itemType: 'post' | 'activity'
    itemId: string
  }
): CollectionItemMutationAck {
  if (!isRecord(value) || !hasExactKeys(value, ITEM_ACK_KEYS)) {
    throw new Error('Malformed collection item acknowledgement')
  }

  const item = parseItem(value.item)
  const resultCodes: readonly CollectionItemMutationResultCode[] =
    ITEM_RESULT_CODES_BY_ACTION[expected.action]
  if (
    value.action !== expected.action ||
    value.actor_id !== expected.actorId ||
    value.collection_id !== expected.collectionId ||
    value.item_type !== expected.itemType ||
    value.item_id !== expected.itemId ||
    typeof value.applied !== 'boolean' ||
    !includesString(resultCodes, value.result_code)
  ) {
    throw new Error('Malformed collection item acknowledgement')
  }

  const successCode = expected.action === 'add' ? 'inserted' : 'removed'
  if (
    value.applied !== (value.result_code === successCode) ||
    (value.applied && item === null) ||
    (!value.applied && item !== null) ||
    (item !== null &&
      (item.collection_id !== expected.collectionId ||
        item.item_type !== expected.itemType ||
        item.item_id !== expected.itemId))
  ) {
    throw new Error('Malformed collection item acknowledgement')
  }

  return value as CollectionItemMutationAck
}
