import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('api:presence')

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()

    const { error: updateError } = await supabase.rpc('record_user_activity', {
      p_user_id: user.id,
      p_seen_at: new Date().toISOString(),
    })

    if (updateError) {
      // Never silently swallow a DB write failure — a swallowed error here is
      // exactly how last_seen_at drifted to NULL for every user undetected.
      logger.error('atomic activity update failed', {
        userId: user.id,
        error: updateError.message,
        code: updateError.code,
      })
      return NextResponse.json({ error: 'Update failed' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    logger.error('POST failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
