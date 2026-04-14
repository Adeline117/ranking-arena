/**
 * Account Deletion Endpoint
 * POST /api/account/delete
 *
 * Soft-deletes user account with 30-day grace period.
 * Requires password confirmation.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { env } from '@/lib/env'
import logger from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
    if (rateLimitResponse) return rateLimitResponse

    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { password, reason } = body as { password?: string; reason?: string }

    if (!password) {
      return NextResponse.json({ error: 'Password required' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin() as SupabaseClient

    // Verify password by attempting sign-in
    const anonClient = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )
    const { error: signInError } = await anonClient.auth.signInWithPassword({
      email: user.email!,
      password,
    })

    if (signInError) {
      return NextResponse.json({ error: 'Invalid password', code: 'INVALID_PASSWORD' }, { status: 403 })
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

    // Cleanup related data (GDPR compliant - 删除所有用户相关数据)
    const cleanupPromises = [
      // Remove exchange connections
      supabase.from('user_exchange_connections').delete().eq('user_id', user.id),
      // Remove trader links
      supabase.from('trader_links').delete().eq('user_id', user.id),
      // Remove from groups
      supabase.from('group_members').delete().eq('user_id', user.id),
      // Remove blocked users entries (both directions)
      supabase.from('blocked_users').delete().eq('blocker_id', user.id),
      supabase.from('blocked_users').delete().eq('blocked_id', user.id),
      // Remove backup codes
      supabase.from('backup_codes').delete().eq('user_id', user.id),
      // Remove login sessions
      supabase.from('login_sessions').delete().eq('user_id', user.id),
      // Clear 2FA secrets
      supabase.from('user_profiles').update({ totp_enabled: false }).eq('id', user.id),
      supabase.from('user_2fa_secrets').delete().eq('user_id', user.id),
      // Remove notifications
      supabase.from('notifications').delete().eq('user_id', user.id),
      // Remove post likes
      supabase.from('post_likes').delete().eq('user_id', user.id),
      // Remove post votes
      supabase.from('post_votes').delete().eq('user_id', user.id),
      // Remove trader follows
      supabase.from('trader_follows').delete().eq('user_id', user.id),
      // Remove user follows (both directions)
      supabase.from('user_follows').delete().eq('follower_id', user.id),
      supabase.from('user_follows').delete().eq('following_id', user.id),
      // Remove bookmarks and bookmark folders
      supabase.from('bookmarks').delete().eq('user_id', user.id),
      supabase.from('bookmark_folders').delete().eq('user_id', user.id),
      // Remove trader alerts
      supabase.from('trader_alerts').delete().eq('user_id', user.id),
      // Remove push subscriptions
      supabase.from('push_subscriptions').delete().eq('user_id', user.id),
      // Remove saved searches
      supabase.from('saved_searches').delete().eq('user_id', user.id),
      // Remove user preferences
      supabase.from('user_preferences').delete().eq('user_id', user.id),
      // Anonymize messages (keep for recipient, but remove sender info)
      supabase.from('messages').update({ sender_id: null }).eq('sender_id', user.id),
    ]

    // Execute all cleanup in parallel, don't fail the deletion if some cleanup fails
    await Promise.allSettled(cleanupPromises.map(p => Promise.resolve(p)))

    // SECURITY: Invalidate all active sessions before banning
    await supabase.auth.admin.signOut(user.id, 'global')

    // Ban the user (876000h ~ 100 years)
    await supabase.auth.admin.updateUserById(user.id, {
      ban_duration: '876000h',
    })

    return NextResponse.json({
      success: true,
      deletion_scheduled_at: scheduledDeletion.toISOString(),
      message: 'Account marked for deletion, recoverable within 30 days',
    })
  } catch (error: unknown) {
    logger.error('[account/delete] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
