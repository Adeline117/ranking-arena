/**
 * 2FA Setup API
 * POST: Generate TOTP secret and QR code for user to scan
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { toDataURL } from 'qrcode'
import { generateTotpSecret } from '@/lib/services/totp'

export const dynamic = 'force-dynamic'

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const token = authHeader.substring(7)
    const supabase = getSupabaseAdmin()
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check if 2FA is already enabled
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('totp_enabled, totp_secret')
      .eq('id', user.id)
      .single()

    if (profileError) {
      console.error('[2FA Setup] Profile fetch error:', profileError)
      return NextResponse.json({ error: 'Failed to fetch user profile' }, { status: 500 })
    }

    if (profile?.totp_enabled) {
      return NextResponse.json(
        { error: '2FA is already enabled. Disable it first to reconfigure.' },
        { status: 400 }
      )
    }

    // Generate TOTP secret
    const userEmail = user.email ?? user.id
    const { secret, uri } = generateTotpSecret(userEmail)

    // Generate QR code as data URL
    const qrCode = await toDataURL(uri)

    // Store the secret temporarily (not enabled yet)
    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ totp_secret: secret })
      .eq('id', user.id)

    if (updateError) {
      console.error('[2FA Setup] Secret storage error:', updateError)
      return NextResponse.json({ error: 'Failed to store TOTP secret' }, { status: 500 })
    }

    return NextResponse.json({ qrCode, secret, uri })
  } catch (error) {
    console.error('[2FA Setup] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
