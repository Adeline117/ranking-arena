import { NextRequest, NextResponse } from 'next/server'
import { SiweMessage } from 'siwe'
import { cookies } from 'next/headers'
import { isAddress } from 'viem'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
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

async function bindWalletToExistingProfile(
  supabase: AdminClient,
  profile: WalletProfile,
  walletAddress: string
): Promise<WalletProfile> {
  const existingWallet = profile.wallet_address?.toLowerCase() || null
  if (existingWallet && existingWallet !== walletAddress) {
    throw new SiweConflictError('This account is already linked to a different wallet')
  }
  if (existingWallet === walletAddress) return profile

  // The auth trigger owns row creation. This route may only bind the verified
  // wallet to the already-provisioned row, and only while it is still unbound.
  const { data, error } = await supabase
    .from('user_profiles')
    .update({ wallet_address: walletAddress })
    .eq('id', profile.id)
    .is('wallet_address', null)
    .select('id, handle, email, wallet_address')
    .maybeSingle()

  if (error) {
    if (error.code === '23505') {
      throw new SiweConflictError('This wallet is already linked to another account')
    }
    logger.error('[SIWE verify] Wallet binding failed', {
      userId: profile.id,
      code: error.code,
    })
    throw error
  }

  if (data?.wallet_address?.toLowerCase() === walletAddress) return data

  // A concurrent request may have won the conditional update. Re-read and
  // accept only an idempotent binding to this exact signed wallet.
  const current = await requireProfileById(supabase, profile.id)
  const currentWallet = current.wallet_address?.toLowerCase() || null
  if (currentWallet === walletAddress) return current
  if (currentWallet) {
    throw new SiweConflictError('This account is already linked to a different wallet')
  }
  throw new Error('Wallet binding affected no profile row')
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
    if (!isAddress(fields.address)) {
      return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 })
    }

    const walletAddress = fields.address.toLowerCase()

    // Consume the nonce before any account mutation. A partial failure must be
    // retried with a fresh signature and can never replay the verified message.
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
      profile = walletProfile
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
          profile = await bindWalletToExistingProfile(supabase, profile, walletAddress)
          action = 'existing_user'
        } catch (lookupError) {
          if (lookupError instanceof SiweConflictError) {
            return NextResponse.json({ error: lookupError.message }, { status: 409 })
          }
          return NextResponse.json({ error: 'Verification service unavailable' }, { status: 503 })
        }
      } else {
        try {
          // public.handle_new_user is the sole row provisioner. Never recreate a
          // missing row here from request/auth metadata.
          profile = await requireProfileById(supabase, created.user.id)
          profile = await bindWalletToExistingProfile(supabase, profile, walletAddress)
          action = 'new_user'
        } catch (profileError) {
          if (profileError instanceof SiweConflictError) {
            return NextResponse.json({ error: profileError.message }, { status: 409 })
          }
          return NextResponse.json({ error: 'Profile provisioning failed' }, { status: 503 })
        }
      }
    }

    try {
      const email = await requireAuthEmail(supabase, profile.id)
      const verificationToken = await requireVerificationToken(supabase, email, profile.id)

      return NextResponse.json({
        action,
        userId: profile.id,
        handle: profile.handle,
        walletAddress,
        email,
        verificationToken,
      })
    } catch {
      return NextResponse.json({ error: 'Failed to create session' }, { status: 503 })
    }
  } catch (err) {
    logger.error('[SIWE verify] Error:', err)
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
  }
}
