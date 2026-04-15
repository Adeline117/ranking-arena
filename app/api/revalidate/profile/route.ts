import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { extractUserFromRequest } from '@/lib/auth/extract-user'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { withApiHandler } from '@/lib/api/with-handler'

export const POST = withApiHandler('revalidate/profile', async (request: NextRequest) => {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  const { user, error: authError } = await extractUserFromRequest(request)
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabaseAdmin = getSupabaseAdmin()

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
})
