import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import crypto from 'crypto'
import { BASE_URL } from '@/lib/constants/urls'

const logger = createLogger('referral-api')

/**
 * GET /api/referral — Get current user's referral code and stats
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser(req)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()

    // Get user's profile with referral code
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('handle, referral_code')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) {
      logger.error('Failed to fetch profile:', profileError.message)
      return NextResponse.json({ error: 'Failed to fetch profile' }, { status: 500 })
    }

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    // Count referred users
    // KEEP 'exact' — referral dashboard exact number ("You've referred
    // N friends"). Scoped via (referred_by) index.
    const { count: referralCount, error: countError } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('referred_by', user.id)

    if (countError) {
      logger.error('Failed to count referrals:', countError.message)
    }

    return NextResponse.json({
      referral_code: profile.referral_code || profile.handle,
      referral_count: referralCount ?? 0,
      referral_link: `${BASE_URL}/?ref=${encodeURIComponent(profile.referral_code || profile.handle || '')}`,
    })
  } catch (error) {
    logger.error('Referral GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/referral — Create or regenerate referral code for user
 */
export async function POST(req: NextRequest) {
  try {
    const rateLimitResult = await checkRateLimit(req, RateLimitPresets.authenticated)
    if (rateLimitResult) return rateLimitResult

    const user = await getAuthUser(req)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()

    // Generate a short unique referral code
    const code = crypto.randomBytes(4).toString('hex') // 8-char hex code

    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ referral_code: code })
      .eq('id', user.id)

    if (updateError) {
      logger.error('Failed to set referral code:', updateError.message)
      return NextResponse.json({ error: 'Failed to create referral code' }, { status: 500 })
    }

    return NextResponse.json({
      referral_code: code,
      referral_link: `${BASE_URL}/?ref=${encodeURIComponent(code)}`,
    })
  } catch (error) {
    logger.error('Referral POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
