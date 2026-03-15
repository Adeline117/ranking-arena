import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export async function POST(request: NextRequest) {
  // Rate limit via Upstash Redis (works across Vercel serverless instances)
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResp) return rateLimitResp

  try {
    const body = await request.json()
    const { message, page_url, user_agent, screenshot } = body

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 })
    }

    if (message.length > 5000) {
      return NextResponse.json({ error: 'Message too long' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    let userId: string | null = null
    const authHeader = request.headers.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
      userId = user?.id ?? null
    }

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
  } catch (err) {
    logger.error('[Feedback] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
