import { NextRequest, NextResponse } from 'next/server'
import { SiweMessage } from 'siwe'
import { cookies } from 'next/headers'
import { isAddress } from 'viem'
import { z } from 'zod'
import { getSupabaseAdmin, getUserAccountStatus } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { consumeSiweNonce } from '@/lib/auth/siwe-nonce'
import { resolveSiweRequestOrigin } from '@/lib/auth/siwe-origin'
import logger from '@/lib/logger'

const EXPECTED_CHAIN_ID = 8453 // Base mainnet (must match the client's chainId)

const requestSchema = z
  .object({
    message: z.string().min(1).max(10_000),
    signature: z.string().min(1).max(2_000),
  })
  .strict()

type AdminClient = ReturnType<typeof getSupabaseAdmin>

type WalletProfile = {
  id: string
  handle: string | null
  email: string | null
  wallet_address: string | null
}

class SiweConflictError extends Error {}
class SiweSuspendedError extends Error {}

function isExistingUserError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return (
    error.code === 'email_exists' ||
    error.code === 'user_already_exists' ||
    Boolean(error.message?.toLowerCase().includes('already been registered'))
  )
}

async function requireProfileById(supabase: AdminClient, userId: string): Promise<WalletProfile> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, handle, email, wallet_address')
    .eq('id', userId)
    .maybeSingle()

  if (error || !data) {
    logger.error('[SIWE verify] Required profile lookup failed', {
      userId,
      code: error?.code,
    })
    throw error || new Error('Profile provisioning is incomplete')
  }

  return data
}

async function requireProfileByWalletEmail(
  supabase: AdminClient,
  email: string
): Promise<WalletProfile> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, handle, email, wallet_address')
    .eq('email', email)
    .maybeSingle()

  if (error || !data) {
    logger.error('[SIWE verify] Existing wallet profile lookup failed', {
      code: error?.code,
    })
    throw error || new Error('Profile provisioning is incomplete')
  }

  return data
}

async function bindWalletToActiveProfile(
  supabase: AdminClient,
  profile: WalletProfile,
  walletAddress: string
): Promise<WalletProfile> {
  // This database authority takes the same lifecycle lock as deletion and
  // moderation, checks every current/legacy suspension marker, and only then
  // performs an idempotent wallet bind. A service-role table UPDATE cannot
  // provide that ordering.
  const { data, error } = await supabase.rpc('bind_siwe_wallet_for_active_profile_atomic', {
    p_user_id: profile.id,
    p_wallet_address: walletAddress,
  })

  if (error) {
    logger.error('[SIWE verify] Atomic wallet admission failed', {
      userId: profile.id,
      code: error.code,
    })
    throw error
  }

  const acknowledgement = Array.isArray(data) && data.length === 1 ? data[0] : null
  if (acknowledgement?.status === 'suspended') {
    throw new SiweSuspendedError('Account unavailable')
  }
  if (acknowledgement?.status === 'conflict') {
    throw new SiweConflictError('This wallet or account is already linked')
  }
  if (
    acknowledgement?.status !== 'active' ||
    acknowledgement.result_user_id !== profile.id ||
    acknowledgement.result_wallet_address?.toLowerCase() !== walletAddress
  ) {
    throw new Error('Invalid atomic wallet admission acknowledgement')
  }

  return {
    id: acknowledgement.result_user_id,
    handle: acknowledgement.result_handle,
    email: acknowledgement.result_email,
    wallet_address: acknowledgement.result_wallet_address,
  }
}

function walletBindingFailure(
  error: unknown,
  unavailableMessage = 'Verification service unavailable'
) {
  if (error instanceof SiweSuspendedError) {
    return NextResponse.json({ error: error.message }, { status: 403 })
  }
  if (error instanceof SiweConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 })
  }
  return NextResponse.json({ error: unavailableMessage }, { status: 503 })
}

async function requireActiveProfileAdmission(userId: string, verifiedEmail: string) {
  const status = await getUserAccountStatus(userId, { verifiedEmail })
  if (status === 'suspended') {
    throw new SiweSuspendedError('Account unavailable')
  }
  if (status !== 'active') {
    throw new Error(`Profile admission failed: ${status}`)
  }
}

async function requireAuthEmail(supabase: AdminClient, userId: string): Promise<string> {
  const { data, error } = await supabase.auth.admin.getUserById(userId)
  const authUser = data?.user
  if (error || !authUser || authUser.id !== userId || !authUser.email) {
    logger.error('[SIWE verify] Auth identity lookup failed', {
      userId,
      code: error?.code,
    })
    throw error || new Error('Auth identity is unavailable')
  }
  return authUser.email
}

async function requireVerificationToken(
  supabase: AdminClient,
  email: string,
  userId: string
): Promise<string> {
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  const token = data?.properties?.hashed_token
  if (error || typeof token !== 'string' || !token) {
    logger.error('[SIWE verify] Session link generation failed', {
      userId,
      code: error?.code,
    })
    throw error || new Error('Session token is unavailable')
  }
  return token
}

/**
 * POST /api/auth/siwe/verify
 *
 * Verifies a SIWE signature, resolves or creates the matching auth identity,
 * requires the database trigger-provisioned profile, and returns a one-time
 * token that the browser must exchange for an exact matching Supabase session.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.auth)
    if (rateLimitResponse) return rateLimitResponse

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
    if (!isAddress(fields.address)) {
      return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 })
    }

    const walletAddress = fields.address.toLowerCase()

    // The cookie is only transport. Redis GETDEL is the cross-request
    // single-winner boundary, so concurrent copies of one signed message can
    // never each mint a session.
    if (!(await consumeSiweNonce(storedNonce))) {
      cookieStore.delete('siwe-nonce')
      return NextResponse.json({ error: 'Nonce expired. Please try again.' }, { status: 400 })
    }
    cookieStore.delete('siwe-nonce')

    const supabase = getSupabaseAdmin()
    const { data: walletProfile, error: walletLookupError } = await supabase
      .from('user_profiles')
      .select('id, handle, email, wallet_address')
      .eq('wallet_address', walletAddress)
      .maybeSingle()

    if (walletLookupError) {
      logger.error('[SIWE verify] Wallet profile lookup failed', {
        code: walletLookupError.code,
      })
      return NextResponse.json({ error: 'Verification service unavailable' }, { status: 503 })
    }

    let action: 'existing_user' | 'new_user'
    let profile: WalletProfile

    if (walletProfile) {
      action = 'existing_user'
      try {
        profile = await bindWalletToActiveProfile(supabase, walletProfile, walletAddress)
      } catch (bindingError) {
        return walletBindingFailure(bindingError)
      }
    } else {
      const walletEmail = `${walletAddress}@wallet.arena`
      const requestedHandle = `0x${walletAddress.slice(2, 8)}`
      const { data: created, error: createError } = await supabase.auth.admin.createUser({
        email: walletEmail,
        email_confirm: true,
        user_metadata: {
          wallet_address: walletAddress,
          handle: requestedHandle,
        },
      })

      if (createError || !created.user) {
        if (!isExistingUserError(createError)) {
          logger.error('[SIWE verify] Auth user creation failed', { code: createError?.code })
          return NextResponse.json({ error: 'Failed to create user' }, { status: 500 })
        }

        try {
          profile = await requireProfileByWalletEmail(supabase, walletEmail)
          profile = await bindWalletToActiveProfile(supabase, profile, walletAddress)
          action = 'existing_user'
        } catch (lookupError) {
          return walletBindingFailure(lookupError)
        }
      } else {
        try {
          // public.handle_new_user is the sole row provisioner. Never recreate a
          // missing row here from request/auth metadata.
          profile = await requireProfileById(supabase, created.user.id)
          profile = await bindWalletToActiveProfile(supabase, profile, walletAddress)
          action = 'new_user'
        } catch (profileError) {
          return walletBindingFailure(profileError, 'Profile provisioning failed')
        }
      }
    }

    try {
      const email = await requireAuthEmail(supabase, profile.id)

      // Auth token minting cannot share a transaction with Postgres. Check the
      // database authority immediately before minting, and once more before
      // releasing the token. A token produced during a losing race is never
      // disclosed, while request admission blocks any later lifecycle change.
      await requireActiveProfileAdmission(profile.id, email)
      const verificationToken = await requireVerificationToken(supabase, email, profile.id)
      await requireActiveProfileAdmission(profile.id, email)

      return NextResponse.json({
        action,
        userId: profile.id,
        handle: profile.handle,
        walletAddress,
        email,
        verificationToken,
      })
    } catch (sessionError) {
      if (sessionError instanceof SiweSuspendedError) {
        return NextResponse.json({ error: sessionError.message }, { status: 403 })
      }
      return NextResponse.json({ error: 'Failed to create session' }, { status: 503 })
    }
  } catch (err) {
    logger.error('[SIWE verify] Error:', err)
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
  }
}
