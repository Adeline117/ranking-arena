import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'
import { z } from 'zod'

const logger = createLogger('api:interactions')

const InteractionSchema = z.object({
  action: z.enum(['like', 'dislike', 'view', 'share', 'bookmark', 'follow', 'unfollow']),
  target_type: z.enum(['post', 'comment', 'trader', 'group', 'user']),
  target_id: z.string().min(1).max(255),
})

export const dynamic = 'force-dynamic'

async function getUserFromCookieOrHeader(request: NextRequest) {
  // Try Authorization header first
  const headerUser = await getAuthUser(request)
  if (headerUser) return headerUser

  // Fallback: try cookie-based auth (for fetch without explicit auth header)
  try {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll() { return cookieStore.getAll() } } }
    )
    const { data: { user } } = await supabase.auth.getUser()
    return user
  } catch (err) {
    console.error('[interactions] Cookie-based auth failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getUserFromCookieOrHeader(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const parsed = InteractionSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) },
        { status: 400 }
      )
    }
    const { action, target_type, target_id } = parsed.data

    const supabase = getSupabaseAdmin()
    await supabase.from('user_interactions').insert({
      user_id: user.id,
      action,
      target_type,
      target_id,
    })

    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (error) {
    logger.error('POST failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
