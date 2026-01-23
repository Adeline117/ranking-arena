/**
 * Account Deletion Endpoint
 * POST /api/account/delete
 *
 * Soft-deletes user account with 30-day grace period.
 * Requires password confirmation.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { password, reason } = body as { password?: string; reason?: string }

    if (!password) {
      return NextResponse.json({ error: 'Password required' }, { status: 400 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Verify password by attempting sign-in
    const anonClient = createClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
    const { error: signInError } = await anonClient.auth.signInWithPassword({
      email: user.email!,
      password,
    })

    if (signInError) {
      return NextResponse.json({ error: '密码错误' }, { status: 403 })
    }

    // Get current profile info for recovery
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle, email')
      .eq('id', user.id)
      .maybeSingle()

    const now = new Date()
    const scheduledDeletion = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) // 30 days

    // Soft delete: set deleted_at, save originals
    await supabase
      .from('user_profiles')
      .update({
        deleted_at: now.toISOString(),
        deletion_scheduled_at: scheduledDeletion.toISOString(),
        deletion_reason: reason || null,
        original_handle: profile?.handle || null,
        original_email: user.email || null,
      })
      .eq('id', user.id)

    // Update author_handle on posts to indicate deleted user
    await supabase
      .from('posts')
      .update({ author_handle: null })
      .eq('author_id', user.id)

    // Update author_handle on comments
    await supabase
      .from('comments')
      .update({ author_handle: null })
      .eq('user_id', user.id)

    // Ban the user (876000h ~ 100 years)
    await supabase.auth.admin.updateUserById(user.id, {
      ban_duration: '876000h',
    })

    return NextResponse.json({
      success: true,
      deletion_scheduled_at: scheduledDeletion.toISOString(),
      message: '账号已标记为注销，30天内可恢复',
    })
  } catch (error) {
    console.error('[account/delete] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
