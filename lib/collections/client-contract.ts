const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const COLLECTION_ITEM_TYPES = ['post', 'activity'] as const
export type CollectionItemType = (typeof COLLECTION_ITEM_TYPES)[number]

export type CollectionSummary = Readonly<{
  id: string
  name: string
  item_count: number
}>

type CollectionRow = Readonly<{
  id: string
  user_id: string
  name: string
  description: string | null
  is_public: boolean | null
  created_at: string | null
  updated_at: string | null
}>

type CollectionItemRow = Readonly<{
  id: string
  collection_id: string
  item_id: string
  item_type: CollectionItemType
  note: string | null
  added_at: string | null
}>

type SuccessEnvelope = Readonly<{
  data: Record<string, unknown>
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value)
}

export function readCollectionUuid(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim() || !UUID_PATTERN.test(value)) return null
  return value.toLowerCase()
}

function sameUuid(left: unknown, right: string): boolean {
  const normalizedLeft = readCollectionUuid(left)
  const normalizedRight = readCollectionUuid(right)
  return normalizedLeft !== null && normalizedLeft === normalizedRight
}

function readSuccessEnvelope(value: unknown): SuccessEnvelope | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'meta', 'success']) ||
    value.success !== true ||
    !isRecord(value.data) ||
    !isRecord(value.meta) ||
    !hasExactKeys(value.meta, ['timestamp']) ||
    !isTimestamp(value.meta.timestamp)
  ) {
    return null
  }
  return { data: value.data }
}

function readCollectionRow(value: unknown): CollectionRow | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'created_at',
      'description',
      'id',
      'is_public',
      'name',
      'updated_at',
      'user_id',
    ]) ||
    !readCollectionUuid(value.id) ||
    !readCollectionUuid(value.user_id) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 50 ||
    value.name !== value.name.trim() ||
    (value.description !== null && typeof value.description !== 'string') ||
    (value.is_public !== null && typeof value.is_public !== 'boolean') ||
    !isNullableTimestamp(value.created_at) ||
    !isNullableTimestamp(value.updated_at)
  ) {
    return null
  }
  return value as CollectionRow
}

function readCollectionItemRow(value: unknown): CollectionItemRow | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['added_at', 'collection_id', 'id', 'item_id', 'item_type', 'note']) ||
    !readCollectionUuid(value.id) ||
    !readCollectionUuid(value.collection_id) ||
    !readCollectionUuid(value.item_id) ||
    !COLLECTION_ITEM_TYPES.includes(value.item_type as CollectionItemType) ||
    (value.note !== null && typeof value.note !== 'string') ||
    !isNullableTimestamp(value.added_at)
  ) {
    return null
  }
  return value as CollectionItemRow
}

export function readCollectionListAcknowledgement(
  value: unknown,
  expectedViewerId: string
): CollectionSummary[] | null {
  const envelope = readSuccessEnvelope(value)
  if (
    !envelope ||
    !hasExactKeys(envelope.data, ['collections', 'viewerId']) ||
    !sameUuid(envelope.data.viewerId, expectedViewerId) ||
    !Array.isArray(envelope.data.collections)
  ) {
    return null
  }

  const seen = new Set<string>()
  const collections: CollectionSummary[] = []
  for (const candidate of envelope.data.collections) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['id', 'item_count', 'name']) ||
      !readCollectionUuid(candidate.id) ||
      typeof candidate.name !== 'string' ||
      candidate.name.length < 1 ||
      candidate.name.length > 50 ||
      candidate.name !== candidate.name.trim() ||
      !Number.isSafeInteger(candidate.item_count) ||
      Number(candidate.item_count) < 0
    ) {
      return null
    }
    const id = readCollectionUuid(candidate.id)!
    if (seen.has(id)) return null
    seen.add(id)
    collections.push({
      id,
      name: candidate.name,
      item_count: Number(candidate.item_count),
    })
  }
  return collections
}

export function readCollectionCreateAcknowledgement(
  value: unknown,
  expected: {
    actorId: string
    description: string | null
    isPublic: boolean
    name: string
  }
): CollectionRow | null {
  const envelope = readSuccessEnvelope(value)
  if (
    !envelope ||
    !hasExactKeys(envelope.data, ['action', 'actorId', 'collection', 'collectionId']) ||
    envelope.data.action !== 'create' ||
    !sameUuid(envelope.data.actorId, expected.actorId)
  ) {
    return null
  }
  const collection = readCollectionRow(envelope.data.collection)
  if (
    !collection ||
    !sameUuid(envelope.data.collectionId, collection.id) ||
    !sameUuid(collection.user_id, expected.actorId) ||
    collection.name !== expected.name ||
    collection.description !== expected.description ||
    collection.is_public !== expected.isPublic
  ) {
    return null
  }
  return collection
}

export function readCollectionItemAddAcknowledgement(
  value: unknown,
  expected: {
    actorId: string
    collectionId: string
    itemId: string
    itemType: CollectionItemType
  }
): CollectionItemRow | null {
  const envelope = readSuccessEnvelope(value)
  if (
    !envelope ||
    !hasExactKeys(envelope.data, [
      'action',
      'actorId',
      'collectionId',
      'item',
      'itemId',
      'itemType',
    ]) ||
    envelope.data.action !== 'add' ||
    !sameUuid(envelope.data.actorId, expected.actorId) ||
    !sameUuid(envelope.data.collectionId, expected.collectionId) ||
    !sameUuid(envelope.data.itemId, expected.itemId) ||
    envelope.data.itemType !== expected.itemType
  ) {
    return null
  }
  const item = readCollectionItemRow(envelope.data.item)
  if (
    !item ||
    !sameUuid(item.collection_id, expected.collectionId) ||
    !sameUuid(item.item_id, expected.itemId) ||
    item.item_type !== expected.itemType
  ) {
    return null
  }
  return item
}
