import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

export type RankingNotificationBatchInput = {
  userId: string
  title: string
  message: string
  link?: string | null
  referenceId: string
}

export type CreatedRankingNotification = {
  requestId: string
  notificationId: string
  userId: string
  title: string
  message: string
  link: string | null
  referenceId: string
  createdAt: string
}

export type RankingNotificationBatchResult = {
  requestedCount: number
  createdCount: number
  deduplicatedCount: number
  skippedCount: number
  created: CreatedRankingNotification[]
}

export type RankingNotificationBatchErrorCode =
  | 'INVALID_REQUEST'
  | 'RPC_ERROR'
  | 'RPC_REJECTED'
  | 'INVALID_ACKNOWLEDGEMENT'

export class RankingNotificationBatchError extends Error {
  constructor(
    readonly code: RankingNotificationBatchErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RankingNotificationBatchError'
  }
}

const NormalizedUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const TimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]?.length ?? 0) <= 6)
const SafeLinkSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.includes('\\') &&
      !/[\u0000-\u001f\u007f]/.test(value)
  )
const RankingNotificationInputSchema = z
  .object({
    userId: NormalizedUuidSchema,
    title: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim().length > 0),
    message: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => value.trim().length > 0),
    link: SafeLinkSchema.nullish().transform((value) => value ?? null),
    referenceId: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)),
  })
  .strict()

const FailureAcknowledgementSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum(['INVALID', 'DUPLICATE_INPUT', 'IDENTITY_CONFLICT']),
  })
  .passthrough()
const ResultAcknowledgementSchema = z
  .object({
    request_id: NormalizedUuidSchema,
    recipient_id: NormalizedUuidSchema,
    type: z.literal('ranking_change'),
    title: z.string(),
    message: z.string(),
    link: z.string().nullable(),
    reference_id: z.string(),
    outcome: z.enum(['CREATED', 'DEDUPLICATED', 'RECIPIENT_UNAVAILABLE']),
    notification_id: NormalizedUuidSchema.nullable(),
    created_at: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const unavailable = value.outcome === 'RECIPIENT_UNAVAILABLE'
    if (
      unavailable !== (value.notification_id === null) ||
      unavailable !== (value.created_at === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ranking notification outcome does not match its persisted identity',
      })
    }
  })
const SuccessAcknowledgementSchema = z
  .object({
    success: z.literal(true),
    type: z.literal('ranking_change'),
    requested_count: z.number().int().min(1).max(500),
    created_count: z.number().int().min(0).max(500),
    deduplicated_count: z.number().int().min(0).max(500),
    skipped_count: z.number().int().min(0).max(500),
    results: z.array(ResultAcknowledgementSchema).min(1).max(500),
  })
  .strict()

type NormalizedRankingNotificationInput = z.infer<typeof RankingNotificationInputSchema>

type RankingNotificationRpcRequest = {
  request_id: string
  recipient_id: string
  title: string
  message: string
  link: string | null
  reference_id: string
}

const BATCH_SIZE = 500

/**
 * Persist retry-safe ranking notifications and require an exact acknowledgement
 * for every requested row. Only rows reported as CREATED are returned to push
 * delivery callers; replays can therefore never re-push a deduplicated row.
 */
export async function createRankingNotificationsBatch(
  supabase: SupabaseClient,
  notifications: RankingNotificationBatchInput[]
): Promise<RankingNotificationBatchResult> {
  if (!Array.isArray(notifications)) {
    throw new RankingNotificationBatchError(
      'INVALID_REQUEST',
      'Ranking notification batch must be an array'
    )
  }
  if (notifications.length === 0) {
    return {
      requestedCount: 0,
      createdCount: 0,
      deduplicatedCount: 0,
      skippedCount: 0,
      created: [],
    }
  }

  const normalized: NormalizedRankingNotificationInput[] = []
  const identities = new Set<string>()
  for (const notification of notifications) {
    const parsed = RankingNotificationInputSchema.safeParse(notification)
    if (!parsed.success) {
      throw new RankingNotificationBatchError(
        'INVALID_REQUEST',
        'Invalid ranking notification request'
      )
    }
    const identity = JSON.stringify([parsed.data.userId, parsed.data.referenceId])
    if (identities.has(identity)) {
      throw new RankingNotificationBatchError(
        'INVALID_REQUEST',
        'Duplicate ranking notification identity'
      )
    }
    identities.add(identity)
    normalized.push(parsed.data)
  }

  const aggregate: RankingNotificationBatchResult = {
    requestedCount: 0,
    createdCount: 0,
    deduplicatedCount: 0,
    skippedCount: 0,
    created: [],
  }

  for (let offset = 0; offset < normalized.length; offset += BATCH_SIZE) {
    const batch = normalized.slice(offset, offset + BATCH_SIZE)
    const requests: RankingNotificationRpcRequest[] = batch.map((notification) => ({
      request_id: randomUUID(),
      recipient_id: notification.userId,
      title: notification.title,
      message: notification.message,
      link: notification.link,
      reference_id: notification.referenceId,
    }))

    const { data, error } = await supabase.rpc('create_ranking_notifications_batch_atomic', {
      p_rows: requests,
    })
    if (error) {
      throw new RankingNotificationBatchError(
        'RPC_ERROR',
        'Ranking notification batch authority unavailable',
        { cause: error }
      )
    }

    const failure = FailureAcknowledgementSchema.safeParse(data)
    if (failure.success) {
      throw new RankingNotificationBatchError(
        'RPC_REJECTED',
        `Ranking notification batch rejected: ${failure.data.reason}`
      )
    }

    const acknowledgement = SuccessAcknowledgementSchema.safeParse(data)
    if (!acknowledgement.success) {
      throw new RankingNotificationBatchError(
        'INVALID_ACKNOWLEDGEMENT',
        'Ranking notification batch returned a malformed acknowledgement'
      )
    }

    const ack = acknowledgement.data
    const outcomeCounts = {
      CREATED: 0,
      DEDUPLICATED: 0,
      RECIPIENT_UNAVAILABLE: 0,
    }
    let exact =
      ack.requested_count === requests.length &&
      ack.results.length === requests.length &&
      ack.created_count + ack.deduplicated_count + ack.skipped_count === requests.length

    for (let index = 0; index < requests.length && index < ack.results.length; index += 1) {
      const request = requests[index]
      const result = ack.results[index]
      outcomeCounts[result.outcome] += 1
      exact =
        exact &&
        result.request_id === request.request_id &&
        result.recipient_id === request.recipient_id &&
        result.title === request.title &&
        result.message === request.message &&
        result.link === request.link &&
        result.reference_id === request.reference_id
    }

    exact =
      exact &&
      outcomeCounts.CREATED === ack.created_count &&
      outcomeCounts.DEDUPLICATED === ack.deduplicated_count &&
      outcomeCounts.RECIPIENT_UNAVAILABLE === ack.skipped_count

    if (!exact) {
      throw new RankingNotificationBatchError(
        'INVALID_ACKNOWLEDGEMENT',
        'Ranking notification batch returned a non-exact acknowledgement'
      )
    }

    aggregate.requestedCount += ack.requested_count
    aggregate.createdCount += ack.created_count
    aggregate.deduplicatedCount += ack.deduplicated_count
    aggregate.skippedCount += ack.skipped_count
    for (const result of ack.results) {
      if (
        result.outcome !== 'CREATED' ||
        result.notification_id === null ||
        result.created_at === null
      ) {
        continue
      }
      aggregate.created.push({
        requestId: result.request_id,
        notificationId: result.notification_id,
        userId: result.recipient_id,
        title: result.title,
        message: result.message,
        link: result.link,
        referenceId: result.reference_id,
        createdAt: result.created_at,
      })
    }
  }

  if (
    aggregate.requestedCount !== normalized.length ||
    aggregate.created.length !== aggregate.createdCount
  ) {
    throw new RankingNotificationBatchError(
      'INVALID_ACKNOWLEDGEMENT',
      'Ranking notification batches did not acknowledge the exact request set'
    )
  }

  return aggregate
}
