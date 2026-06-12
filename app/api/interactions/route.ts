import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError, success } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { z } from 'zod'

const logger = createLogger('api:interactions')

const SingleEventSchema = z.object({
  // 'click' included for lib/tracking.ts consumers (e.g. FollowingPageClient);
  // /api/track already writes 'click' rows to the same user_interactions table.
  action: z.enum(['like', 'dislike', 'view', 'click', 'share', 'bookmark', 'follow', 'unfollow']),
  target_type: z.enum(['post', 'comment', 'trader', 'group', 'user']),
  target_id: z.string().min(1).max(255),
  metadata: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})

const InteractionSchema = z.union([
  // Legacy format (existing consumers)
  SingleEventSchema,
  // Exchange link click format (ExchangeLinksBar)
  z.object({
    type: z.literal('exchange_link_click'),
    platform: z.string().min(1).max(50),
    traderKey: z.string().min(1).max(255),
  }),
  // Batch format (lib/tracking.ts flushQueue — queue caps at 20 events)
  z.object({
    events: z.array(SingleEventSchema).min(1).max(20),
  }),
])

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const parsed = InteractionSchema.safeParse(body)
    if (!parsed.success) {
      return badRequest(
        `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      )
    }

    // Normalize all formats into interactions table rows
    const data = parsed.data
    const toRow = (event: z.infer<typeof SingleEventSchema>) => ({
      user_id: user.id,
      action: event.action,
      target_type: event.target_type,
      target_id: event.target_id,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    })

    const insertRows =
      'type' in data
        ? [
            {
              user_id: user.id,
              action: 'view',
              target_type: 'trader' as const,
              target_id: `${data.platform}:${data.traderKey}`,
              metadata: { type: data.type, platform: data.platform },
            },
          ]
        : 'events' in data
          ? data.events.map(toRow)
          : [toRow(data)]

    const { error } = await supabase.from('user_interactions').insert(insertRows)

    if (error) {
      logger.error('POST insert failed', { error: error.message })
      return serverError('Failed to record interaction')
    }

    return success({ ok: true }, 201)
  },
  { name: 'interactions-post', rateLimit: 'write' }
)
