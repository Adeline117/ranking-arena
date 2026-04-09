import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('feedback')

export const POST = withPublic(async ({ user, supabase, request }) => {
  const body = await request.json()
  const { message, page_url, user_agent, screenshot } = body

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return NextResponse.json({ error: 'Message is required' }, { status: 400 })
  }

  if (message.length > 5000) {
    return NextResponse.json({ error: 'Message too long' }, { status: 400 })
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
    return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}, { name: 'post-feedback', rateLimit: 'sensitive', readsAuth: true })
