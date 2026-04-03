/**
 * Data Export API
 * POST: Export all user data as JSON
 * Rate limited to 1 export per 24 hours
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Allow up to 60s for large exports

const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24 hours
const EXPORT_ROW_LIMIT = 10_000 // Max rows per table to prevent timeout

interface UserProfile {
  id: string
  handle: string | null
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  created_at: string
  updated_at: string | null
  last_export_at: string | null
}

interface ExportData {
  exportedAt: string
  profile: UserProfile | null
  posts: unknown[]
  comments: unknown[]
  follows: {
    following: unknown[]
    followers: unknown[]
  }
  tips: {
    sent: unknown[]
    received: unknown[]
  }
}

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // CSRF validation
    const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(cookieToken, headerToken)) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    const supabase = getSupabaseAdmin()

    // Check rate limit: 1 export per 24 hours
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, handle, display_name, avatar_url, bio, created_at, updated_at, last_export_at')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      logger.error('[Export] Profile fetch error:', profileError)
      return NextResponse.json({ error: 'Failed to fetch user profile' }, { status: 500 })
    }

    const typedProfile = profile as UserProfile

    if (typedProfile.last_export_at) {
      const lastExport = new Date(typedProfile.last_export_at).getTime()
      const now = Date.now()
      if (now - lastExport < EXPORT_COOLDOWN_MS) {
        const nextAvailable = new Date(lastExport + EXPORT_COOLDOWN_MS).toISOString()
        return NextResponse.json(
          { error: 'Export rate limit exceeded. Try again after: ' + nextAvailable },
          { status: 429 }
        )
      }
    }

    // Collect user data in parallel
    const [postsResult, commentsResult, followingResult, followersResult, tipsSentResult, tipsReceivedResult] = await Promise.all([
      // GDPR data export: select('*') is intentional — users are entitled to a complete copy of all their data
      // .limit(EXPORT_ROW_LIMIT) prevents timeout on prolific users (Supabase default is 1000 which silently truncates)
      supabase
        .from('posts')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(EXPORT_ROW_LIMIT),
      supabase
        .from('comments')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(EXPORT_ROW_LIMIT),
      supabase
        .from('user_follows')
        .select('*')
        .eq('follower_id', user.id)
        .limit(EXPORT_ROW_LIMIT),
      supabase
        .from('user_follows')
        .select('*')
        .eq('following_id', user.id)
        .limit(EXPORT_ROW_LIMIT),
      supabase
        .from('tips')
        .select('*')
        .eq('sender_id', user.id)
        .order('created_at', { ascending: false })
        .limit(EXPORT_ROW_LIMIT),
      supabase
        .from('tips')
        .select('*')
        .eq('receiver_id', user.id)
        .order('created_at', { ascending: false })
        .limit(EXPORT_ROW_LIMIT),
    ])

    // Update last export timestamp
    await supabase
      .from('user_profiles')
      .update({ last_export_at: new Date().toISOString() })
      .eq('id', user.id)

    const exportData: ExportData = {
      exportedAt: new Date().toISOString(),
      profile: typedProfile,
      posts: postsResult.data ?? [],
      comments: commentsResult.data ?? [],
      follows: {
        following: followingResult.data ?? [],
        followers: followersResult.data ?? [],
      },
      tips: {
        sent: tipsSentResult.data ?? [],
        received: tipsReceivedResult.data ?? [],
      },
    }

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="ranking-arena-export-${user.id}.json"`,
      },
    })
  } catch (error: unknown) {
    logger.error('[Export] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
