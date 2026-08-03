import { z } from 'zod'
import { getHandleShapeError } from '@/lib/identity/handle-policy'

export const POST_DRAFT_STORAGE_VERSION = 1 as const
const POST_DRAFT_STORAGE_PREFIX = 'ranking-arena:post-draft:v1'

const URL_CONTROL_OR_SPACE_PATTERN = /[\u0000-\u001f\u007f\s]/

const NormalizedUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const CanonicalUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const ProfileHandleSchema = z
  .string()
  .refine((value) => getHandleShapeError(value, { allowUnchangedLegacyDot: true }) === null)

const HttpUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => value === value.trim())
  .refine((value) => !URL_CONTROL_OR_SPACE_PATTERN.test(value))
  .refine((value) => {
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  })

const UploadedImageSchema = z
  .object({
    url: HttpUrlSchema,
    fileName: z.string().min(1).max(1_024),
  })
  .strict()

const ProfileUploadedVideoSchema = z
  .object({
    url: HttpUrlSchema,
    fileName: z.string().min(1).max(1_024),
    fileSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

const GroupUploadedVideoSchema = z
  .object({
    url: HttpUrlSchema,
    fileName: z.string().min(1).max(1_024),
    fileSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    thumbnail: HttpUrlSchema.optional(),
  })
  .strict()

const PollOptionSchema = z
  .object({
    text: z.string().max(1_000),
    votes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

const POLL_DURATION_VALUES = new Set([0, 1, 6, 12, 24, 72, 168])
const PollDurationSchema = z
  .number()
  .int()
  .min(0)
  .max(168)
  .refine((value) => POLL_DURATION_VALUES.has(value))

const CommonDraftShape = {
  title: z.string().max(100),
  content: z.string().max(10_000),
  images: z.array(UploadedImageSchema).max(9),
  pollEnabled: z.boolean(),
  pollOptions: z.array(PollOptionSchema).min(2).max(6),
  pollType: z.enum(['single', 'multiple']),
  pollDuration: PollDurationSchema,
  isSensitive: z.boolean(),
  contentWarning: z.string().max(200),
} as const

const ProfilePostDraftDataSchema = z
  .object({
    ...CommonDraftShape,
    videos: z.array(ProfileUploadedVideoSchema).max(1),
    visibility: z.enum(['public', 'followers']),
  })
  .strict()

const GroupPostDraftDataSchema = z
  .object({
    ...CommonDraftShape,
    videos: z.array(GroupUploadedVideoSchema).max(1),
  })
  .strict()

const ProfileDestinationInputSchema = z
  .object({ type: z.literal('profile'), handle: ProfileHandleSchema })
  .strict()
const GroupDestinationInputSchema = z
  .object({ type: z.literal('group'), groupId: NormalizedUuidSchema })
  .strict()
const DestinationInputSchema = z.discriminatedUnion('type', [
  ProfileDestinationInputSchema,
  GroupDestinationInputSchema,
])

const ProfileDestinationBodySchema = z
  .object({ type: z.literal('profile'), handle: ProfileHandleSchema })
  .strict()
const GroupDestinationBodySchema = z
  .object({ type: z.literal('group'), groupId: CanonicalUuidSchema })
  .strict()

const ScopeInputSchema = z
  .object({
    ownerId: NormalizedUuidSchema,
    destination: DestinationInputSchema,
  })
  .strict()

const ProfilePostDraftEnvelopeSchema = z
  .object({
    version: z.literal(POST_DRAFT_STORAGE_VERSION),
    ownerId: CanonicalUuidSchema,
    destination: ProfileDestinationBodySchema,
    draft: ProfilePostDraftDataSchema,
  })
  .strict()

const GroupPostDraftEnvelopeSchema = z
  .object({
    version: z.literal(POST_DRAFT_STORAGE_VERSION),
    ownerId: CanonicalUuidSchema,
    destination: GroupDestinationBodySchema,
    draft: GroupPostDraftDataSchema,
  })
  .strict()

const PostDraftEnvelopeSchema = z.union([
  ProfilePostDraftEnvelopeSchema,
  GroupPostDraftEnvelopeSchema,
])

export type ProfilePostDraftData = z.infer<typeof ProfilePostDraftDataSchema>
export type GroupPostDraftData = z.infer<typeof GroupPostDraftDataSchema>

export type ProfilePostDraftScope = {
  ownerId: string
  destination: { type: 'profile'; handle: string }
}

export type GroupPostDraftScope = {
  ownerId: string
  destination: { type: 'group'; groupId: string }
}

export type PostDraftScope = ProfilePostDraftScope | GroupPostDraftScope
export type PostDraftData = ProfilePostDraftData | GroupPostDraftData

export type PostDraftStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

type NormalizedPostDraftScope = z.infer<typeof ScopeInputSchema>

function normalizedScope(scope: PostDraftScope): NormalizedPostDraftScope | null {
  const parsed = ScopeInputSchema.safeParse(scope)
  return parsed.success ? parsed.data : null
}

function keyForNormalizedScope(scope: NormalizedPostDraftScope): string {
  const destinationKey =
    scope.destination.type === 'profile'
      ? `profile:${encodeURIComponent(scope.destination.handle)}`
      : `group:${scope.destination.groupId}`
  return `${POST_DRAFT_STORAGE_PREFIX}:${scope.ownerId}:${destinationKey}`
}

/** A versioned key bound to one exact authenticated owner and destination. */
export function postDraftStorageKey(scope: PostDraftScope): string | null {
  const normalized = normalizedScope(scope)
  return normalized ? keyForNormalizedScope(normalized) : null
}

function destinationsEqual(
  left: NormalizedPostDraftScope['destination'],
  right: z.infer<typeof ProfileDestinationBodySchema> | z.infer<typeof GroupDestinationBodySchema>
): boolean {
  if (left.type === 'profile' && right.type === 'profile') {
    return left.handle === right.handle
  }
  if (left.type === 'group' && right.type === 'group') {
    return left.groupId === right.groupId
  }
  return false
}

export function readPostDraft(
  storage: PostDraftStorage,
  scope: ProfilePostDraftScope
): ProfilePostDraftData | null
export function readPostDraft(
  storage: PostDraftStorage,
  scope: GroupPostDraftScope
): GroupPostDraftData | null
export function readPostDraft(
  storage: PostDraftStorage,
  scope: PostDraftScope
): PostDraftData | null {
  const normalized = normalizedScope(scope)
  if (!normalized) return null

  let serialized: string | null
  try {
    serialized = storage.getItem(keyForNormalizedScope(normalized))
  } catch {
    return null
  }
  if (serialized === null) return null

  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    return null
  }

  const parsed = PostDraftEnvelopeSchema.safeParse(value)
  if (
    !parsed.success ||
    parsed.data.ownerId !== normalized.ownerId ||
    !destinationsEqual(normalized.destination, parsed.data.destination)
  ) {
    return null
  }

  return parsed.data.draft
}

export function savePostDraft(
  storage: PostDraftStorage,
  scope: ProfilePostDraftScope,
  draft: ProfilePostDraftData
): boolean
export function savePostDraft(
  storage: PostDraftStorage,
  scope: GroupPostDraftScope,
  draft: GroupPostDraftData
): boolean
export function savePostDraft(
  storage: PostDraftStorage,
  scope: PostDraftScope,
  draft: PostDraftData
): boolean {
  const normalized = normalizedScope(scope)
  if (!normalized) return false

  const envelope = {
    version: POST_DRAFT_STORAGE_VERSION,
    ownerId: normalized.ownerId,
    destination: normalized.destination,
    draft,
  }
  const parsed = PostDraftEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) return false

  try {
    storage.setItem(keyForNormalizedScope(normalized), JSON.stringify(parsed.data))
    return true
  } catch {
    return false
  }
}

/** Remove only the current owner/destination key; legacy unscoped keys are untouched. */
export function removePostDraft(storage: PostDraftStorage, scope: PostDraftScope): boolean {
  const normalized = normalizedScope(scope)
  if (!normalized) return false
  try {
    storage.removeItem(keyForNormalizedScope(normalized))
    return true
  } catch {
    return false
  }
}

export function isPostDraftMeaningful(
  destination: PostDraftScope['destination'],
  draft: PostDraftData
): boolean {
  const defaultPollDuration = destination.type === 'profile' ? 0 : 24
  const pollOptionsChanged =
    draft.pollOptions.length !== 2 ||
    draft.pollOptions.some((option) => option.text.trim() !== '' || option.votes !== 0)
  const profileVisibilityChanged = 'visibility' in draft && draft.visibility !== 'public'

  return Boolean(
    draft.title.trim() ||
    draft.content.trim() ||
    draft.images.length > 0 ||
    draft.videos.length > 0 ||
    draft.pollEnabled ||
    pollOptionsChanged ||
    draft.pollType !== 'single' ||
    draft.pollDuration !== defaultPollDuration ||
    profileVisibilityChanged ||
    draft.isSensitive ||
    draft.contentWarning.trim()
  )
}
