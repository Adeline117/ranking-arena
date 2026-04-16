import { withPublic } from '@/lib/api/middleware'
import { success, badRequest, serverError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('feedback')

export const POST = withPublic(async ({ user, supabase, request }) => {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const { message, page_url, user_agent, screenshot } = body as {
    message?: string; page_url?: string; user_agent?: string; screenshot?: string
  }

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return badRequest('Message is required')
  }

  if (message.length > 5000) {
    return badRequest('Message too long')
  }

  // user may be non-null if Authorization header was present (middleware performs opportunistic auth)
  const userId = user?.id ?? null

  const { error } = await supabase.from('feedback').insert({
    user_id: userId,
    message: message.trim(),
    page_url: page_url || null,
    user_agent: user_agent || null,
    // Limit screenshot to 50KB (was 500KB) to prevent DB abuse
    screenshot_url: screenshot ? screenshot.slice(0, 50000) : null,
  })

  if (error) {
    logger.error('[Feedback] Insert error:', error)
    return serverError('Failed to save feedback')
  }

  return success({ ok: true })
}, { name: 'post-feedback', rateLimit: 'sensitive', readsAuth: true })
