import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'

/**
 * POST /api/auth/siwe/unlink
 *
 * Unlinks the wallet address from the authenticated user's profile.
 * If the user signed in via wallet (email ends with @wallet.arena),
 * they cannot unlink because it would lock them out.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.auth)
    if (rateLimitResponse) return rateLimitResponse
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Prevent unlinking if this is a wallet-only account
    if (user.email?.endsWith('@wallet.arena')) {
      return NextResponse.json(
        { error: 'Cannot unlink wallet from a wallet-only account. Link an email first.' },
        { status: 400 }
      )
    }

    const supabase = getSupabaseAdmin()

    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ wallet_address: null })
      .eq('id', user.id)

    if (updateError) {
      return NextResponse.json({ error: 'Failed to unlink wallet' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('[SIWE unlink] Error:', err)
    return NextResponse.json({ error: 'Failed to unlink wallet' }, { status: 500 })
  }
}
