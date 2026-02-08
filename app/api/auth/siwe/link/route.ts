import { NextRequest, NextResponse } from 'next/server'
import { SiweMessage } from 'siwe'
import { cookies } from 'next/headers'
import { isAddress } from 'viem'
import { getSupabaseAdmin, getAuthUser } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

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

    const { message, signature } = await request.json()

    if (!message || !signature) {
      return NextResponse.json({ error: 'Missing message or signature' }, { status: 400 })
    }

    const cookieStore = await cookies()
    const storedNonce = cookieStore.get('siwe-nonce')?.value

    if (!storedNonce) {
      return NextResponse.json({ error: 'Nonce expired. Please try again.' }, { status: 400 })
    }

    const siweMessage = new SiweMessage(message)
    const { data: fields, success } = await siweMessage.verify({
      signature,
      nonce: storedNonce,
    })

    if (!success) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
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
        console.error('[SIWE link] Profile insert failed:', insertError)
        return NextResponse.json({ error: 'Failed to create profile for wallet link' }, { status: 500 })
      }
    } else {
      const { error: updateError } = await supabase
        .from('user_profiles')
        .update({ wallet_address: walletAddress })
        .eq('id', user.id)

      if (updateError) {
        console.error('[SIWE link] Wallet update failed:', updateError)
        return NextResponse.json({ error: 'Failed to link wallet' }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      walletAddress,
    })
  } catch (err) {
    console.error('[SIWE link] Error:', err)
    return NextResponse.json({ error: 'Failed to link wallet' }, { status: 500 })
  }
}
