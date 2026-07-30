import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
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

    // Bearer admission and mutation are separate requests. Recheck lifecycle
    // state and release the wallet under the same subject/wallet lock order as
    // SIWE binding so a concurrent ban, deletion, or re-link has one outcome.
    const { data, error: unlinkError } = await supabase.rpc(
      'unbind_siwe_wallet_for_active_profile_atomic',
      { p_user_id: user.id }
    )
    if (unlinkError) {
      logger.error('[SIWE unlink] Atomic wallet unlink failed', {
        userId: user.id,
        code: unlinkError.code,
      })
      return NextResponse.json({ error: 'Failed to unlink wallet' }, { status: 503 })
    }

    const acknowledgement = Array.isArray(data) && data.length === 1 ? data[0] : null
    if (acknowledgement?.status === 'suspended') {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }
    if (
      (acknowledgement?.status !== 'unbound' && acknowledgement?.status !== 'already_unbound') ||
      acknowledgement.result_user_id !== user.id
    ) {
      logger.error('[SIWE unlink] Invalid atomic wallet unlink acknowledgement', {
        userId: user.id,
        status: acknowledgement?.status,
      })
      return NextResponse.json({ error: 'Failed to unlink wallet' }, { status: 503 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('[SIWE unlink] Error:', err)
    return NextResponse.json({ error: 'Failed to unlink wallet' }, { status: 500 })
  }
}
