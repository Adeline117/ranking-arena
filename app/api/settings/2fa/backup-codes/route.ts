/**
 * 2FA Backup Codes API
 * GET: Regenerate backup codes for the authenticated user
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { generateBackupCodes, hashBackupCode } from '@/lib/services/totp'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export const dynamic = 'force-dynamic'

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function GET(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.auth)
    if (rateLimitResponse) return rateLimitResponse

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

    // Check that 2FA is enabled
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('totp_enabled')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      console.error('[2FA Backup Codes] Profile fetch error:', profileError)
      return NextResponse.json({ error: 'Failed to fetch user profile' }, { status: 500 })
    }

    if (!profile.totp_enabled) {
      return NextResponse.json(
        { error: '2FA is not enabled. Enable 2FA first.' },
        { status: 400 }
      )
    }

    // Generate new backup codes
    const backupCodes = generateBackupCodes(8)
    const hashedCodes = backupCodes.map((plainCode: string) => ({
      user_id: user.id,
      code_hash: hashBackupCode(plainCode),
      used: false,
    }))

    // Delete old backup codes for this user
    const { error: deleteError } = await supabase
      .from('backup_codes')
      .delete()
      .eq('user_id', user.id)

    if (deleteError) {
      console.error('[2FA Backup Codes] Delete old codes error:', deleteError)
      return NextResponse.json({ error: 'Failed to regenerate backup codes' }, { status: 500 })
    }

    // Insert new hashed codes
    const { error: insertError } = await supabase
      .from('backup_codes')
      .insert(hashedCodes)

    if (insertError) {
      console.error('[2FA Backup Codes] Insert error:', insertError)
      return NextResponse.json({ error: 'Failed to store new backup codes' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      backupCodes,
    })
  } catch (error: unknown) {
    console.error('[2FA Backup Codes] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
