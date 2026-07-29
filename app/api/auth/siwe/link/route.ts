import { NextRequest, NextResponse } from 'next/server'
import { SiweMessage } from 'siwe'
import { cookies } from 'next/headers'
import { isAddress } from 'viem'
import { z } from 'zod'
import { getSupabaseAdmin, getProvisioningAuthUser } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { consumeSiweNonce } from '@/lib/auth/siwe-nonce'
import { resolveSiweRequestOrigin } from '@/lib/auth/siwe-origin'
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
    const requestOrigin = resolveSiweRequestOrigin(request)
    if (!requestOrigin) {
      return NextResponse.json({ error: 'Unrecognized request origin' }, { status: 400 })
    }
    if (
      fields.domain !== requestOrigin.domain ||
      fields.uri !== requestOrigin.origin ||
      fields.chainId !== EXPECTED_CHAIN_ID
    ) {
      return NextResponse.json({ error: 'Domain or chain mismatch' }, { status: 400 })
    }

    // Validate wallet address format
    if (!isAddress(fields.address)) {
      return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 })
    }
    const walletAddress = fields.address.toLowerCase()

    if (!(await consumeSiweNonce(storedNonce))) {
      cookieStore.delete('siwe-nonce')
      return NextResponse.json({ error: 'Nonce expired. Please try again.' }, { status: 400 })
    }
    cookieStore.delete('siwe-nonce')

    const supabase = getSupabaseAdmin()

    // Authentication admission and this mutation are separate requests. The
    // RPC rechecks lifecycle state while holding the same subject lock as
    // moderation/deletion, and serializes ownership of the signed wallet.
    const { data, error: bindingError } = await supabase.rpc(
      'bind_siwe_wallet_for_active_profile_atomic',
      {
        p_user_id: user.id,
        p_wallet_address: walletAddress,
      }
    )
    if (bindingError) {
      logger.error('[SIWE link] Atomic wallet admission failed', {
        userId: user.id,
        code: bindingError.code,
      })
      return NextResponse.json({ error: 'Failed to link wallet' }, { status: 503 })
    }

    const acknowledgement = Array.isArray(data) && data.length === 1 ? data[0] : null
    if (acknowledgement?.status === 'suspended') {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }
    if (acknowledgement?.status === 'conflict') {
      return NextResponse.json(
        { error: 'This wallet or account is already linked' },
        { status: 409 }
      )
    }
    if (
      acknowledgement?.status !== 'active' ||
      acknowledgement.result_user_id !== user.id ||
      acknowledgement.result_wallet_address?.toLowerCase() !== walletAddress
    ) {
      logger.error('[SIWE link] Invalid atomic wallet acknowledgement', {
        userId: user.id,
        status: acknowledgement?.status,
      })
      return NextResponse.json({ error: 'Profile provisioning is incomplete' }, { status: 503 })
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
