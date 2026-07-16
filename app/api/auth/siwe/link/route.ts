import { NextRequest, NextResponse } from 'next/server'
import { SiweMessage } from 'siwe'
import { cookies } from 'next/headers'
import { isAddress } from 'viem'
import { z } from 'zod'
import { getSupabaseAdmin, getProvisioningAuthUser } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'

// Must match the verify route's chainId — Base mainnet.
const EXPECTED_CHAIN_ID = 8453

const requestSchema = z
  .object({
    message: z.string().min(1).max(10_000),
    signature: z.string().min(1).max(2_000),
  })
  .strict()

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
    const user = await getProvisioningAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 })
    }

    const parsedBody = requestSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: 'Missing or invalid message or signature' },
        { status: 400 }
      )
    }
    const { message, signature } = parsedBody.data

    const cookieStore = await cookies()
    const storedNonce = cookieStore.get('siwe-nonce')?.value

    if (!storedNonce) {
      return NextResponse.json({ error: 'Nonce expired. Please try again.' }, { status: 400 })
    }

    const siweMessage = new SiweMessage(message)
    const {
      data: fields,
      success,
      error,
    } = await siweMessage.verify({
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

    // Validate wallet address format
    if (!isAddress(fields.address)) {
      return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 })
    }
    const walletAddress = fields.address.toLowerCase()

    cookieStore.delete('siwe-nonce')

    const supabase = getSupabaseAdmin()

    // The auth trigger is the only profile provisioner. Linking cannot repair a
    // missing profile from bearer-token or SIWE metadata.
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, wallet_address')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError || !profile) {
      logger.error('[SIWE link] Required profile lookup failed', {
        userId: user.id,
        code: profileError?.code,
      })
      return NextResponse.json({ error: 'Profile provisioning is incomplete' }, { status: 503 })
    }

    const currentWallet = profile.wallet_address?.toLowerCase() || null
    if (currentWallet && currentWallet !== walletAddress) {
      return NextResponse.json(
        { error: 'This account is already linked to a different wallet' },
        { status: 409 }
      )
    }

    // Check if another user already has this wallet. Query failures must never
    // be treated as an available wallet.
    const { data: existing, error: existingError } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('wallet_address', walletAddress)
      .neq('id', user.id)
      .maybeSingle()

    if (existingError) {
      logger.error('[SIWE link] Wallet ownership lookup failed', {
        userId: user.id,
        code: existingError.code,
      })
      return NextResponse.json({ error: 'Wallet lookup failed' }, { status: 503 })
    }

    if (existing) {
      return NextResponse.json(
        { error: 'This wallet is already linked to another account' },
        { status: 409 }
      )
    }

    if (!currentWallet) {
      // Bind only an unbound row. A concurrent mutation cannot be overwritten,
      // and a zero-row result is a hard failure rather than fake success.
      const { data: updatedProfile, error: updateError } = await supabase
        .from('user_profiles')
        .update({ wallet_address: walletAddress })
        .eq('id', user.id)
        .is('wallet_address', null)
        .select('id, wallet_address')
        .maybeSingle()

      if (updateError || updatedProfile?.wallet_address?.toLowerCase() !== walletAddress) {
        logger.error('[SIWE link] Wallet update failed', {
          userId: user.id,
          code: updateError?.code,
        })
        if (updateError?.code === '23505') {
          return NextResponse.json(
            { error: 'This wallet is already linked to another account' },
            { status: 409 }
          )
        }
        return NextResponse.json({ error: 'Failed to link wallet' }, { status: 503 })
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
