import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    // Verify authentication
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // Get user's handle to revalidate their profile page
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('handle')
      .eq('id', user.id)
      .maybeSingle()

    // Revalidate paths
    revalidatePath(`/u/${user.id}`)
    if (profile?.handle) {
      revalidatePath(`/u/${profile.handle}`)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error('[Revalidate Profile] Error:', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
