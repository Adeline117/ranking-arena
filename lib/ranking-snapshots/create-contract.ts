import { z } from 'zod'

export const RANKING_SNAPSHOT_CREATE_OPERATION = 'create_snapshot' as const
export const RANKING_SNAPSHOT_CREATE_MAX_REQUEST_BYTES = 1024 * 1024
export const RANKING_SNAPSHOT_CREATE_MAX_TRADERS = 100
export const RANKING_SNAPSHOT_CREATE_REQUEST_ID_RE = /^[0-9a-f]{32}$/
export const RANKING_SNAPSHOT_CREATE_SHARE_TOKEN_RE = /^[0-9a-f]{32}$/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u
const DATA_AVAILABILITY_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/
const MAX_METRIC_ABS = 1_000_000_000_000
const MAX_INT32 = 2_147_483_647

function canonicalString(maximum: number) {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim())
    .refine((value) => value === value.normalize('NFC'))
    .refine((value) => !CONTROL_RE.test(value))
}

const NullableMetricSchema = z.number().finite().min(-MAX_METRIC_ABS).max(MAX_METRIC_ABS).nullable()

const NullableCountSchema = z.number().int().min(0).max(MAX_INT32).nullable()

const DataAvailabilitySchema = z
  .record(z.string(), z.boolean())
  .refine((value) => Object.keys(value).length <= 64)
  .refine((value) => Object.keys(value).every((key) => DATA_AVAILABILITY_KEY_RE.test(key)))
  .nullable()

export const RankingSnapshotTraderCreateSchema = z
  .object({
    rank: z.number().int().min(1).max(RANKING_SNAPSHOT_CREATE_MAX_TRADERS),
    trader_id: canonicalString(500),
    handle: canonicalString(300).nullable(),
    source: canonicalString(100).regex(SOURCE_RE),
    avatar_url: canonicalString(2048)
      .url()
      .refine((value) => value.startsWith('https://') || value.startsWith('http://'))
      .nullable(),
    roi: NullableMetricSchema,
    pnl: NullableMetricSchema,
    win_rate: NullableMetricSchema,
    max_drawdown: NullableMetricSchema,
    trades_count: NullableCountSchema,
    followers: NullableCountSchema,
    arena_score: NullableMetricSchema,
    return_score: NullableMetricSchema,
    drawdown_score: NullableMetricSchema,
    stability_score: NullableMetricSchema,
    data_availability: DataAvailabilitySchema,
  })
  .strict()

export const RankingSnapshotCreateRequestSchema = z
  .object({
    operation: z.literal(RANKING_SNAPSHOT_CREATE_OPERATION),
    request_id: z.string().regex(RANKING_SNAPSHOT_CREATE_REQUEST_ID_RE),
    exchange: canonicalString(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    time_range: z.enum(['7D', '30D', '90D']),
    traders: z
      .array(RankingSnapshotTraderCreateSchema)
      .min(1)
      .max(RANKING_SNAPSHOT_CREATE_MAX_TRADERS),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = new Set<string>()
    for (let index = 0; index < value.traders.length; index += 1) {
      const trader = value.traders[index]
      if (trader.rank !== index + 1) {
        context.addIssue({
          code: 'custom',
          path: ['traders', index, 'rank'],
          message: 'Ranks must be contiguous and ordered from one',
        })
      }

      const identity = JSON.stringify([trader.source, trader.trader_id])
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: ['traders', index, 'trader_id'],
          message: 'Trader identities must be unique within a snapshot',
        })
      }
      identities.add(identity)
    }

    if (value.traders[0]?.handle === null) {
      context.addIssue({
        code: 'custom',
        path: ['traders', 0, 'handle'],
        message: 'The top trader must have a handle',
      })
    }
    if (value.traders[0]?.roi === null) {
      context.addIssue({
        code: 'custom',
        path: ['traders', 0, 'roi'],
        message: 'The top trader must have an ROI',
      })
    }
  })

const RankingSnapshotResourceAckSchema = z
  .object({
    id: z.string().regex(UUID_RE),
    share_token: z.string().regex(RANKING_SNAPSHOT_CREATE_SHARE_TOKEN_RE),
    created_by: z.string().regex(UUID_RE),
    exchange: canonicalString(64),
    time_range: z.enum(['7D', '30D', '90D']),
    total_traders: z.number().int().min(1).max(RANKING_SNAPSHOT_CREATE_MAX_TRADERS),
    top_trader_handle: canonicalString(300),
    top_trader_roi: z.number().finite().min(-MAX_METRIC_ABS).max(MAX_METRIC_ABS),
    data_captured_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict()

export const AtomicRankingSnapshotCreateAckSchema = z
  .object({
    status: z.enum(['created', 'replayed']),
    applied: z.boolean(),
    operation: z.literal(RANKING_SNAPSHOT_CREATE_OPERATION),
    actor_id: z.string().regex(UUID_RE),
    request_id: z.string().regex(RANKING_SNAPSHOT_CREATE_REQUEST_ID_RE),
    snapshot: RankingSnapshotResourceAckSchema,
  })
  .strict()
  .refine(
    (value) =>
      (value.status === 'created' && value.applied) ||
      (value.status === 'replayed' && !value.applied),
    { message: 'Snapshot create status and applied flag disagree' }
  )

export type RankingSnapshotCreateRequest = z.infer<typeof RankingSnapshotCreateRequestSchema>
export type AtomicRankingSnapshotCreateAck = z.infer<typeof AtomicRankingSnapshotCreateAckSchema>

export type RankingSnapshotJsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid' | 'too_large' }

function declaredBodyLength(request: Request): number | null | 'invalid' {
  const raw = request.headers.get('content-length')
  if (raw == null) return null
  const length = Number(raw)
  return Number.isSafeInteger(length) && length >= 0 ? length : 'invalid'
}

/** Stream the request body so a forged or absent Content-Length cannot bypass the cap. */
export async function readBoundedRankingSnapshotJson(
  request: Request
): Promise<RankingSnapshotJsonReadResult> {
  const declaredLength = declaredBodyLength(request)
  if (declaredLength === 'invalid') return { ok: false, reason: 'invalid' }
  if (declaredLength !== null && declaredLength > RANKING_SNAPSHOT_CREATE_MAX_REQUEST_BYTES) {
    return { ok: false, reason: 'too_large' }
  }

  if (request.body && typeof request.body.getReader === 'function') {
    const reader = request.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytesRead = 0
    let text = ''
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytesRead += chunk.value.byteLength
        if (bytesRead > RANKING_SNAPSHOT_CREATE_MAX_REQUEST_BYTES) {
          await reader.cancel()
          return { ok: false, reason: 'too_large' }
        }
        text += decoder.decode(chunk.value, { stream: true })
      }
      text += decoder.decode()
      return { ok: true, value: JSON.parse(text) }
    } catch {
      return { ok: false, reason: 'invalid' }
    }
  }

  // Lightweight route-test doubles do not always expose a ReadableStream.
  try {
    const value: unknown = await request.json()
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
    return bytes > RANKING_SNAPSHOT_CREATE_MAX_REQUEST_BYTES
      ? { ok: false, reason: 'too_large' }
      : { ok: true, value }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

export function acknowledgementMatchesSnapshotRequest(
  acknowledgement: AtomicRankingSnapshotCreateAck,
  actorId: string,
  input: RankingSnapshotCreateRequest
): boolean {
  const topTrader = input.traders[0]
  const capturedAt = Date.parse(acknowledgement.snapshot.data_captured_at)
  const expiresAt = Date.parse(acknowledgement.snapshot.expires_at)

  return (
    acknowledgement.actor_id === actorId &&
    acknowledgement.request_id === input.request_id &&
    acknowledgement.snapshot.created_by === actorId &&
    acknowledgement.snapshot.exchange === input.exchange &&
    acknowledgement.snapshot.time_range === input.time_range &&
    acknowledgement.snapshot.total_traders === input.traders.length &&
    acknowledgement.snapshot.top_trader_handle === topTrader.handle &&
    acknowledgement.snapshot.top_trader_roi === topTrader.roi &&
    Number.isFinite(capturedAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt - capturedAt === 7 * 24 * 60 * 60 * 1000
  )
}
