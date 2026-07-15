import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { badRequest, serverError, success } from '@/lib/api/response'
import { isAnalyticsEventName } from '@/lib/analytics/events'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('analytics-events')

const primitive = z.union([z.string().max(300), z.number().finite(), z.boolean()])
const payloadSchema = z
  .object({
    event_id: z.uuid(),
    event_name: z.string().min(1).max(80).refine(isAnalyticsEventName),
    anonymous_id: z.uuid(),
    session_id: z.uuid(),
    path: z.string().max(500).optional(),
    properties: z
      .record(z.string().max(80), primitive)
      .refine((value) => Object.keys(value).length <= 30),
    occurred_at: z.iso.datetime({ offset: true }),
  })
  .strict()

function analyticsSecret(): string | null {
  return (
    process.env.ANALYTICS_HASH_SALT ||
    process.env.ENCRYPTION_KEY_PART1 ||
    process.env.ENCRYPTION_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    null
  )
}

function hashIdentifier(secret: string, kind: 'anonymous' | 'session', value: string): string {
  return createHmac('sha256', secret).update(`${kind}:${value}`).digest('hex')
}

export const POST = withPublic(
  async ({ user, supabase, request }) => {
    const parsed = payloadSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return badRequest('Invalid analytics event')

    const occurredAt = new Date(parsed.data.occurred_at)
    const now = Date.now()
    if (
      occurredAt.getTime() < now - 24 * 60 * 60 * 1000 ||
      occurredAt.getTime() > now + 5 * 60 * 1000
    ) {
      return badRequest('Analytics event timestamp out of range')
    }

    const secret = analyticsSecret()
    if (!secret) {
      logger.error('No private analytics hashing secret is configured')
      return serverError('Analytics unavailable')
    }

    const { error } = await supabase.from('product_events').insert({
      event_id: parsed.data.event_id,
      event_name: parsed.data.event_name,
      user_id: user?.id ?? null,
      anonymous_id_hash: hashIdentifier(secret, 'anonymous', parsed.data.anonymous_id),
      session_id_hash: hashIdentifier(secret, 'session', parsed.data.session_id),
      source: 'web',
      path: parsed.data.path ?? null,
      properties: parsed.data.properties,
      occurred_at: parsed.data.occurred_at,
    })

    if (error && error.code !== '23505') {
      logger.error('Product event insert failed', { code: error.code, message: error.message })
      return serverError('Analytics unavailable')
    }

    return success({ accepted: true }, 202)
  },
  { name: 'analytics-events', rateLimit: 'analytics', readsAuth: true }
)
