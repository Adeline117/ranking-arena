import { NextRequest, NextResponse } from 'next/server'
import { SiweMessage } from 'siwe'
import { cookies } from 'next/headers'
import { isAddress } from 'viem'
import { getSupabaseAdmin, getAuthUser } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'

// Must match the verify route's chainId — Base mainnet.
const EXPECTED_CHAIN_ID = 8453

/**
 * POST /api/auth/siwe/link
 *
 * Links a wallet address to an existing authenticated Supabase user.
 * Requires the user to be logged in via email/password already.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.auth)
    if (rateLimitResponse) return rateLimitResponse
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    let message: string, signature: string
    try {
      const body = await request.json()
      message = body.message
      signature = body.signature
    } catch {
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 })
    }

    if (!message || !signature) {
      return NextResponse.json({ error: 'Missing message or signature' }, { status: 400 })
    }

    const cookieStore = await cookies()
    const storedNonce = cookieStore.get('siwe-nonce')?.value

    if (!storedNonce) {
      return NextResponse.json({ error: 'Nonce expired. Please try again.' }, { status: 400 })
    }

    const siweMessage = new SiweMessage(message)
    const { data: fields, success, error } = await siweMessage.verify({
      signature,
      nonce: storedNonce,
    })

    if (!success || error) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    // SECURITY (audit P1-SEC-3): validate domain/uri/chainId to prevent
    // cross-site signature relay. Previously the link route trusted any
    // SIWE message that verified against the stored nonce, so an attacker
    // who phished a victim into signing a SIWE message for phishing.com
    // (or any other origin) could replay that signature here and link the
    // victim's wallet to the attacker's logged-in Supabase session,
    // hijacking the victim's wallet identity in Arena. The /verify route
    // already does this — link must mirror it.
    const requestHost = request.headers.get('host')
    const requestOrigin = request.headers.get('origin')
    if (!requestHost || !requestOrigin) {
      return NextResponse.json({ error: 'Missing required Host or Origin header' }, { status: 400 })
    }
    if (
      fields.domain !== requestHost ||
      fields.uri !== requestOrigin ||
      fields.chainId !== EXPECTED_CHAIN_ID
    ) {
      return NextResponse.json({ error: 'Domain or chain mismatch' }, { status: 400 })
    }

    const walletAddress = fields.address.toLowerCase()

    // Validate wallet address format
    if (!isAddress(fields.address)) {
      return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 })
    }

    cookieStore.delete('siwe-nonce')

    const supabase = getSupabaseAdmin()

    // Check if another user already has this wallet
    const { data: existing } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('wallet_address', walletAddress)
      .neq('id', user.id)
      .maybeSingle()

    if (existing) {
      return NextResponse.json(
        { error: 'This wallet is already linked to another account' },
        { status: 409 }
      )
    }

    // Link wallet to current user
    // First check if profile exists
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile) {
      // Profile doesn't exist yet - create it with wallet address
      const { error: insertError } = await supabase
        .from('user_profiles')
        .insert({
          id: user.id,
          email: user.email || `${walletAddress}@wallet.arena`,
          wallet_address: walletAddress,
        })

      if (insertError) {
        logger.error('[SIWE link] Profile insert failed:', insertError)
        return NextResponse.json({ error: 'Failed to create profile for wallet link' }, { status: 500 })
      }
    } else {
      const { error: updateError } = await supabase
        .from('user_profiles')
        .update({ wallet_address: walletAddress })
        .eq('id', user.id)

      if (updateError) {
        logger.error('[SIWE link] Wallet update failed:', updateError)
        return NextResponse.json({ error: 'Failed to link wallet' }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      walletAddress,
    })
  } catch (err) {
    logger.error('[SIWE link] Error:', err)
    return NextResponse.json({ error: 'Failed to link wallet' }, { status: 500 })
  }
}
