import { NextRequest, NextResponse } from 'next/server'
import { SiweMessage } from 'siwe'
import { cookies } from 'next/headers'
import { isAddress } from 'viem'
import { getSupabaseAdmin, getAuthUser } from '@/lib/supabase/server'

/**
 * POST /api/auth/siwe/link
 *
 * Links a wallet address to an existing authenticated Supabase user.
 * Requires the user to be logged in via email/password already.
 */
export async function POST(request: NextRequest) {
  try {
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
    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ wallet_address: walletAddress })
      .eq('id', user.id)

    if (updateError) {
      return NextResponse.json({ error: 'Failed to link wallet' }, { status: 500 })
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
