/**
 * Data Export API
 * POST: Export all user data as JSON
 * Rate limited to 1 export per 24 hours
 */

import { NextRequest, NextResponse } from 'next/server'
import { getProvisioningAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
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
  avatar_url: string | null
  bio: string | null
  created_at: string
  updated_at: string | null
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
    const user = await getProvisioningAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // CSRF validation
    const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(cookieToken, headerToken)) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    const supabase = getSupabaseAdmin() as SupabaseClient

    // Check rate limit: 1 export per 24 hours
    // maybeSingle: auth users without a user_profiles row are a legitimate state
    // (profile creation happens elsewhere) — export proceeds with profile: null.
    // NOTE: user_profiles has no display_name column (selecting it 400s with 42703).
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, handle, avatar_url, bio, created_at, updated_at')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) {
      logger.error('[Export] Profile fetch error:', profileError)
      return NextResponse.json({ error: 'Failed to fetch user profile' }, { status: 500 })
    }

    const typedProfile = (profile as UserProfile | null) ?? null

    // Best-effort cooldown check. last_export_at has no migration and does not
    // exist in prod (42703) — querying it separately keeps the main profile
    // fetch working on both schemas; a missing column just skips the cooldown
    // (the route-level write rate limit above still applies).
    const { data: exportMeta, error: exportMetaError } = await supabase
      .from('user_profiles')
      .select('last_export_at')
      .eq('id', user.id)
      .maybeSingle()
    const lastExportAt = exportMetaError
      ? null
      : ((exportMeta as { last_export_at?: string | null } | null)?.last_export_at ?? null)

    if (lastExportAt) {
      const lastExport = new Date(lastExportAt).getTime()
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
    const [
      postsResult,
      commentsResult,
      followingResult,
      followersResult,
      tipsSentResult,
      tipsReceivedResult,
    ] = await Promise.all([
      // GDPR data export: select('*') is intentional — users are entitled to a complete copy of all their data
      // .limit(EXPORT_ROW_LIMIT) prevents timeout on prolific users (Supabase default is 1000 which silently truncates)
      supabase
        .from('posts')
        .select('*')
        .eq('author_id', user.id) // posts 用 author_id(无 user_id 列)——旧 eq('user_id') 导出永远空
        .order('created_at', { ascending: false })
        .limit(EXPORT_ROW_LIMIT),
      supabase
        .from('comments')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(EXPORT_ROW_LIMIT),
      supabase.from('user_follows').select('*').eq('follower_id', user.id).limit(EXPORT_ROW_LIMIT),
      supabase.from('user_follows').select('*').eq('following_id', user.id).limit(EXPORT_ROW_LIMIT),
      supabase
        .from('tips')
        .select('*')
        .eq('from_user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(EXPORT_ROW_LIMIT),
      supabase
        .from('tips')
        .select('*')
        .eq('to_user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(EXPORT_ROW_LIMIT),
    ])

    // Update last export timestamp (best-effort: the column does not exist in
    // prod — see cooldown note above — so the result is intentionally unchecked)
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
