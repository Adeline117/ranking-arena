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
import {
  DataExportReadError,
  DataExportTooLargeError,
  fetchAllExportRows,
  type ExportDataset,
} from '@/lib/account/data-export'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Allow up to 60s for large exports

const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24 hours

interface UserProfile {
  id: string
  handle: string | null
  avatar_url: string | null
  bio: string | null
  created_at: string
  updated_at: string | null
}

interface StoredUserProfile extends UserProfile {
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

const EXPORT_DATASETS = {
  posts: { name: 'posts', table: 'posts', ownerColumn: 'author_id' },
  comments: { name: 'comments', table: 'comments', ownerColumn: 'user_id' },
  following: {
    name: 'following',
    table: 'user_follows',
    ownerColumn: 'follower_id',
  },
  followers: {
    name: 'followers',
    table: 'user_follows',
    ownerColumn: 'following_id',
  },
  tipsSent: { name: 'tips.sent', table: 'tips', ownerColumn: 'from_user_id' },
  tipsReceived: { name: 'tips.received', table: 'tips', ownerColumn: 'to_user_id' },
} satisfies Record<string, ExportDataset>

function parseStoredTimestamp(value: string, field: string): number {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${field} timestamp`)
  return timestamp
}

async function claimExportCooldown(
  supabase: SupabaseClient,
  userId: string,
  claimTime: Date
): Promise<{ claimed: true } | { claimed: false; nextAvailable: string }> {
  const cutoff = new Date(claimTime.getTime() - EXPORT_COOLDOWN_MS).toISOString()
  const { data: claimedProfile, error: claimError } = await supabase
    .from('user_profiles')
    .update({ last_export_at: claimTime.toISOString() })
    .eq('id', userId)
    .or(`last_export_at.is.null,last_export_at.lte.${cutoff}`)
    .select('id')
    .maybeSingle()

  if (claimError) throw claimError
  if (claimedProfile) return { claimed: true }

  // A zero-row conditional update normally means another request won while
  // this export was being assembled. Re-read only the timestamp so a deleted
  // profile or storage failure cannot be mislabeled as an ordinary cooldown.
  const { data: currentProfile, error: currentProfileError } = await supabase
    .from('user_profiles')
    .select('last_export_at')
    .eq('id', userId)
    .maybeSingle()
  if (currentProfileError || !currentProfile || !currentProfile.last_export_at) {
    throw currentProfileError || new Error('Export cooldown profile is missing')
  }

  const lastExport = parseStoredTimestamp(currentProfile.last_export_at, 'last_export_at')
  return {
    claimed: false,
    nextAvailable: new Date(lastExport + EXPORT_COOLDOWN_MS).toISOString(),
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

    // Profile provisioning is an authentication invariant. Missing rows fail
    // closed: without one there is no durable tuple on which to serialize the
    // 24-hour cooldown.
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, handle, avatar_url, bio, created_at, updated_at, last_export_at')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError || !profile) {
      logger.error('[Export] Profile fetch error:', profileError)
      return NextResponse.json({ error: 'Profile provisioning is incomplete' }, { status: 503 })
    }

    const { last_export_at: lastExportAt, ...typedProfile } = profile as StoredUserProfile

    if (lastExportAt) {
      const lastExport = parseStoredTimestamp(lastExportAt, 'last_export_at')
      const now = Date.now()
      if (now - lastExport < EXPORT_COOLDOWN_MS) {
        const nextAvailable = new Date(lastExport + EXPORT_COOLDOWN_MS).toISOString()
        return NextResponse.json(
          { error: 'Export rate limit exceeded. Try again after: ' + nextAvailable },
          { status: 429 }
        )
      }
    }

    // Collect complete datasets in parallel. Every table is keyset-paginated;
    // any page error aborts the whole export instead of returning partial JSON.
    const [posts, comments, following, followers, tipsSent, tipsReceived] = await Promise.all([
      fetchAllExportRows(supabase, EXPORT_DATASETS.posts, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.comments, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.following, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.followers, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.tipsSent, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.tipsReceived, user.id),
    ])

    const exportData: ExportData = {
      exportedAt: new Date().toISOString(),
      profile: typedProfile,
      posts,
      comments,
      follows: {
        following,
        followers,
      },
      tips: {
        sent: tipsSent,
        received: tipsReceived,
      },
    }

    // Serialize and construct the response before consuming the durable
    // cooldown. Then atomically claim it; concurrent requests may both read,
    // but only one can return a download.
    const response = new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="ranking-arena-export-${user.id}.json"`,
      },
    })
    const cooldown = await claimExportCooldown(supabase, user.id, new Date())
    if (!cooldown.claimed) {
      return NextResponse.json(
        { error: 'Export rate limit exceeded. Try again after: ' + cooldown.nextAvailable },
        { status: 429 }
      )
    }
    return response
  } catch (error: unknown) {
    if (error instanceof DataExportTooLargeError) {
      logger.error('[Export] Dataset exceeds synchronous export limit:', error.dataset)
      return NextResponse.json(
        { error: 'Your export is too large to prepare synchronously. Please contact support.' },
        { status: 413 }
      )
    }
    if (error instanceof DataExportReadError) {
      logger.error('[Export] Dataset fetch error:', {
        dataset: error.dataset,
        error: error.causeValue,
      })
      return NextResponse.json({ error: 'Failed to prepare a complete export' }, { status: 500 })
    }
    logger.error('[Export] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
