import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError, success } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { z } from 'zod'

const logger = createLogger('api:interactions')

const InteractionSchema = z.object({
  action: z.enum(['like', 'dislike', 'view', 'share', 'bookmark', 'follow', 'unfollow']),
  target_type: z.enum(['post', 'comment', 'trader', 'group', 'user']),
  target_id: z.string().min(1).max(255),
})

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
        `Invalid input: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      )
    }
    const { action, target_type, target_id } = parsed.data

    const { error } = await supabase.from('user_interactions').insert({
      user_id: user.id,
      action,
      target_type,
      target_id,
    })

    if (error) {
      logger.error('POST insert failed', { error: error.message })
      return serverError('Failed to record interaction')
    }

    return success({ ok: true }, 201)
  },
  { name: 'interactions-post', rateLimit: 'write' }
)
