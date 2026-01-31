import { NextRequest, NextResponse } from 'next/server'
import { SiweMessage } from 'siwe'
import { cookies } from 'next/headers'
import { getSupabaseAdmin } from '@/lib/supabase/server'

/**
 * POST /api/auth/siwe/verify
 *
 * Verifies a SIWE signed message against the stored nonce.
 * If the wallet address is linked to a Supabase user, returns a session.
 * If not, creates a new Supabase user with the wallet address.
 */
export async function POST(request: NextRequest) {
  try {
    const { message, signature } = await request.json()

    if (!message || !signature) {
      return NextResponse.json({ error: 'Missing message or signature' }, { status: 400 })
    }

    // Verify nonce from cookie
    const cookieStore = await cookies()
    const storedNonce = cookieStore.get('siwe-nonce')?.value

    if (!storedNonce) {
      return NextResponse.json({ error: 'Nonce expired. Please try again.' }, { status: 400 })
    }

    // Parse and verify the SIWE message
    const siweMessage = new SiweMessage(message)
    const { data: fields, success, error } = await siweMessage.verify({
      signature,
      nonce: storedNonce,
    })

    if (!success || error) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const walletAddress = fields.address.toLowerCase()

    // Clear the nonce cookie after successful verification
    cookieStore.delete('siwe-nonce')

    const supabase = getSupabaseAdmin()

    // Check if a user_profile already has this wallet address
    const { data: existingProfile } = await supabase
      .from('user_profiles')
      .select('id, handle, email, wallet_address')
      .eq('wallet_address', walletAddress)
      .maybeSingle()

    if (existingProfile) {
      // Existing user — generate a Supabase session for them
      // We use admin API to create a magic link session
      const { data: sessionData, error: sessionError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: existingProfile.email || `${walletAddress}@wallet.arena`,
      })

      if (sessionError || !sessionData) {
        return NextResponse.json({ error: 'Failed to create session' }, { status: 500 })
      }

      return NextResponse.json({
        action: 'existing_user',
        userId: existingProfile.id,
        handle: existingProfile.handle,
        walletAddress,
        // The client will use the hashed_token to complete sign-in
        verificationToken: sessionData.properties?.hashed_token,
        email: existingProfile.email || `${walletAddress}@wallet.arena`,
      })
    }

    // New wallet user — create a Supabase auth user with a wallet-derived email
    const walletEmail = `${walletAddress}@wallet.arena`
    const handle = `0x${walletAddress.slice(2, 8)}`

    const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
      email: walletEmail,
      email_confirm: true,
      user_metadata: {
        wallet_address: walletAddress,
        handle,
      },
    })

    if (createError || !newUser.user) {
      // User might already exist with this email
      if (createError?.message?.includes('already been registered')) {
        const { data: existingUser } = await supabase.auth.admin.listUsers()
        const user = existingUser?.users?.find(u => u.email === walletEmail)

        if (user) {
          // Link wallet to existing user
          await supabase
            .from('user_profiles')
            .update({ wallet_address: walletAddress })
            .eq('id', user.id)

          const { data: sessionData } = await supabase.auth.admin.generateLink({
            type: 'magiclink',
            email: walletEmail,
          })

          return NextResponse.json({
            action: 'existing_user',
            userId: user.id,
            walletAddress,
            verificationToken: sessionData?.properties?.hashed_token,
            email: walletEmail,
          })
        }
      }
      return NextResponse.json({ error: 'Failed to create user' }, { status: 500 })
    }

    // Create user profile with wallet address
    await supabase
      .from('user_profiles')
      .upsert({
        id: newUser.user.id,
        email: walletEmail,
        handle,
        wallet_address: walletAddress,
      }, { onConflict: 'id' })

    // Generate session for the new user
    const { data: sessionData } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: walletEmail,
    })

    return NextResponse.json({
      action: 'new_user',
      userId: newUser.user.id,
      handle,
      walletAddress,
      verificationToken: sessionData?.properties?.hashed_token,
      email: walletEmail,
    })
  } catch (err) {
    console.error('[SIWE verify] Error:', err)
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
  }
}
