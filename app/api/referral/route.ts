import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
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
    const rateLimitResult = await checkRateLimit(req, RateLimitPresets.authenticated)
    if (rateLimitResult) return rateLimitResult

    const user = await getAuthUser(req)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin() as SupabaseClient

    // Get user's profile.
    // NOTE: user_profiles has NO `referral_code` column in prod (42703) —
    // selecting it 500s the whole route. We select only `handle` and use it
    // as the referral code. If a referral_code column is ever added via
    // migration, restore it to this select and to the POST handler below.
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('handle')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) {
      logger.error('Failed to fetch profile:', profileError.message)
      return NextResponse.json({ error: 'Failed to fetch profile' }, { status: 500 })
    }

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    // Count referred users.
    // NOTE: `referred_by` column also does not exist in prod (42703) — the
    // count query fails non-fatally and we report 0. Kept so the count
    // starts working automatically if the column is added later.
    const { count: referralCount, error: countError } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('referred_by', user.id)

    if (countError) {
      logger.warn('Failed to count referrals (referred_by column missing?):', countError.message)
    }

    // referral_code column absent in prod — handle IS the referral code
    const referralCode = profile.handle || ''
    return NextResponse.json({
      referral_code: referralCode,
      referral_count: referralCount ?? 0,
      referral_link: `${BASE_URL}/?ref=${encodeURIComponent(referralCode)}`,
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

    const supabase = getSupabaseAdmin() as SupabaseClient

    // Generate a short unique referral code
    const code = crypto.randomBytes(4).toString('hex') // 8-char hex code

    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ referral_code: code })
      .eq('id', user.id)

    if (updateError) {
      // NOTE: user_profiles has NO `referral_code` column in prod (42703), so
      // custom codes cannot be persisted. Degrade gracefully: fall back to the
      // user's handle as their (stable) referral code instead of 500ing.
      const columnMissing =
        updateError.code === '42703' || updateError.message?.includes('referral_code')
      if (columnMissing) {
        logger.warn('referral_code column missing — falling back to handle as referral code')
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', user.id)
          .maybeSingle()
        const fallbackCode = profile?.handle || ''
        if (!fallbackCode) {
          return NextResponse.json(
            { error: 'Referral code generation unavailable (set a profile handle first)' },
            { status: 503 }
          )
        }
        return NextResponse.json({
          referral_code: fallbackCode,
          referral_link: `${BASE_URL}/?ref=${encodeURIComponent(fallbackCode)}`,
          regenerated: false,
        })
      }
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
