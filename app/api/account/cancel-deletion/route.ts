/**
 * Cancel Account Deletion Endpoint
 * POST /api/account/cancel-deletion
 *
 * Restores a soft-deleted account within the 30-day grace period.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  // Rate limit: sensitive operation
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const body = await request.json()
    const { email, password } = body as { email?: string; password?: string }

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Find the deleted profile by email
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, original_handle, original_email, deletion_scheduled_at, deleted_at')
      .eq('original_email', email)
      .not('deleted_at', 'is', null)
      .maybeSingle()

    if (!profile) {
      return NextResponse.json({ error: 'No pending account deletion found', code: 'NOT_FOUND' }, { status: 404 })
    }

    // Check if still within grace period
    if (profile.deletion_scheduled_at && new Date(profile.deletion_scheduled_at) < new Date()) {
      return NextResponse.json({ error: 'Recovery period has passed, account permanently deleted', code: 'EXPIRED' }, { status: 410 })
    }

    // Verify password
    const anonClient = createClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

    // Unban user first to allow sign-in check
    await supabase.auth.admin.updateUserById(profile.id, {
      ban_duration: 'none',
    })

    const { error: signInError } = await anonClient.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) {
      // Re-ban if password wrong
      await supabase.auth.admin.updateUserById(profile.id, {
        ban_duration: '876000h',
      })
      return NextResponse.json({ error: 'Invalid password', code: 'INVALID_PASSWORD' }, { status: 403 })
    }

    // Restore profile
    await supabase
      .from('user_profiles')
      .update({
        deleted_at: null,
        deletion_scheduled_at: null,
        deletion_reason: null,
        handle: profile.original_handle,
        original_handle: null,
        original_email: null,
      })
      .eq('id', profile.id)

    // Restore author_handle on posts
    if (profile.original_handle) {
      await supabase
        .from('posts')
        .update({ author_handle: profile.original_handle })
        .eq('author_id', profile.id)

      await supabase
        .from('comments')
        .update({ author_handle: profile.original_handle })
        .eq('user_id', profile.id)
    }

    return NextResponse.json({
      success: true,
      message: 'Account restored successfully',
    })
  } catch (error: unknown) {
    logger.error('[account/cancel-deletion] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
