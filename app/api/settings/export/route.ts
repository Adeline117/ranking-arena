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
  projectExportRecord,
  type ExportDataset,
} from '@/lib/account/data-export'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Allow up to 60s for large exports

const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24 hours

interface ExportData {
  exportedAt: string
  profile: Record<string, unknown>
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
  account: {
    login_sessions: unknown[]
    api_keys: unknown[]
    passkeys: unknown[]
    push_subscriptions: unknown[]
    backup_codes: unknown[]
    recovery_tokens: unknown[]
  }
}

const PROFILE_EXPORT_COLUMNS = [
  'id',
  'handle',
  'avatar_url',
  'cover_url',
  'bio',
  'email',
  'wallet_address',
  'market_pairs',
  'interests',
  'created_at',
  'updated_at',
  'email_digest',
  'email_digest_last_sent',
  'notify_follow',
  'notify_like',
  'notify_comment',
  'notify_mention',
  'notify_message',
  'notify_trader_events',
  'dm_permission',
  'show_followers',
  'show_following',
  'show_pro_badge',
  'onboarding_completed',
  'subscription_tier',
  'pro_plan',
  'pro_expires_at',
  'is_pro',
  'api_tier',
  'totp_enabled',
  'is_verified',
  'is_verified_trader',
  'verified_trader_source',
  'verified_trader_id',
  'verified_at',
  'is_banned',
  'banned_at',
  'ban_expires_at',
  'banned_reason',
  'deleted_at',
  'deletion_scheduled_at',
  'deletion_reason',
  'referral_code',
  'referred_by',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'original_email',
  'original_handle',
  'search_history',
] as const

const EXPORT_DATASETS = {
  posts: {
    name: 'posts',
    table: 'posts',
    ownerColumn: 'author_id',
    selectColumns: [
      'id',
      'title',
      'content',
      'content_warning',
      'images',
      'links',
      'hashtags',
      'mentions',
      'language',
      'visibility',
      'status',
      'group_id',
      'original_post_id',
      'poll_enabled',
      'poll_id',
      'is_sensitive',
      'is_pinned',
      'created_at',
      'updated_at',
      'deleted_at',
      'delete_reason',
    ],
  },
  comments: {
    name: 'comments',
    table: 'comments',
    ownerColumn: 'user_id',
    selectColumns: [
      'id',
      'post_id',
      'parent_id',
      'content',
      'created_at',
      'updated_at',
      'deleted_at',
      'delete_reason',
    ],
  },
  following: {
    name: 'following',
    table: 'user_follows',
    ownerColumn: 'follower_id',
    selectColumns: ['id', 'following_id', 'created_at'],
  },
  followers: {
    name: 'followers',
    table: 'user_follows',
    ownerColumn: 'following_id',
    selectColumns: ['id', 'follower_id', 'created_at'],
  },
  tipsSent: {
    name: 'tips.sent',
    table: 'tips',
    ownerColumn: 'from_user_id',
    selectColumns: [
      'id',
      'to_user_id',
      'post_id',
      'amount_cents',
      'message',
      'status',
      'created_at',
      'updated_at',
      'completed_at',
    ],
  },
  tipsReceived: {
    name: 'tips.received',
    table: 'tips',
    ownerColumn: 'to_user_id',
    selectColumns: [
      'id',
      'from_user_id',
      'post_id',
      'amount_cents',
      'message',
      'status',
      'created_at',
      'updated_at',
      'completed_at',
    ],
  },
  loginSessions: {
    name: 'account.login_sessions',
    table: 'login_sessions',
    ownerColumn: 'user_id',
    selectColumns: [
      'id',
      'device_info',
      'is_current',
      'revoked',
      'last_active_at',
      'user_agent',
      'ip_address',
      'created_at',
    ],
  },
  apiKeys: {
    name: 'account.api_keys',
    table: 'api_keys',
    ownerColumn: 'user_id',
    selectColumns: [
      'id',
      'name',
      'active',
      'tier',
      'daily_limit',
      'request_count_today',
      'created_at',
      'last_used_at',
      'revoked_at',
    ],
  },
  passkeys: {
    name: 'account.passkeys',
    table: 'user_passkeys',
    ownerColumn: 'user_id',
    selectColumns: ['id', 'device_name', 'transports', 'created_at', 'last_used_at'],
  },
  pushSubscriptions: {
    name: 'account.push_subscriptions',
    table: 'push_subscriptions',
    ownerColumn: 'user_id',
    selectColumns: [
      'id',
      'platform',
      'provider',
      'device_name',
      'enabled',
      'created_at',
      'updated_at',
    ],
  },
  backupCodes: {
    name: 'account.backup_codes',
    table: 'backup_codes',
    ownerColumn: 'user_id',
    selectColumns: ['id', 'used', 'used_at', 'created_at'],
  },
  recoveryTokens: {
    name: 'account.recovery_tokens',
    table: 'account_recovery_tokens',
    ownerColumn: 'user_id',
    selectColumns: ['id', 'created_at', 'expires_at', 'used_at'],
  },
} satisfies Record<string, ExportDataset>

function normalizeFollowRows(rows: Record<string, unknown>[], direction: 'following' | 'follower') {
  const otherUserColumn = direction === 'following' ? 'following_id' : 'follower_id'
  return rows.map((row) => ({
    id: row.id,
    direction,
    other_user_id: row[otherUserColumn],
    created_at: row.created_at,
  }))
}

function normalizeTipRows(rows: Record<string, unknown>[], direction: 'sent' | 'received') {
  const counterpartyColumn = direction === 'sent' ? 'to_user_id' : 'from_user_id'
  return rows.map((row) => ({
    id: row.id,
    direction,
    counterparty_user_id: row[counterpartyColumn],
    post_id: row.post_id,
    amount_cents: row.amount_cents,
    message: row.message,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  }))
}

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
      .select([...PROFILE_EXPORT_COLUMNS, 'last_export_at'].join(','))
      .eq('id', user.id)
      .maybeSingle()

    if (profileError || !profile) {
      logger.error('[Export] Profile fetch error:', profileError)
      return NextResponse.json({ error: 'Profile provisioning is incomplete' }, { status: 503 })
    }

    const lastExportAt = (profile as unknown as Record<string, unknown>).last_export_at
    if (lastExportAt !== null && typeof lastExportAt !== 'string') {
      throw new DataExportReadError('profile', new Error('Invalid last_export_at value'))
    }
    const typedProfile = projectExportRecord('profile', profile, PROFILE_EXPORT_COLUMNS)

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
    const [
      posts,
      comments,
      following,
      followers,
      tipsSent,
      tipsReceived,
      loginSessions,
      apiKeys,
      passkeys,
      pushSubscriptions,
      backupCodes,
      recoveryTokens,
    ] = await Promise.all([
      fetchAllExportRows(supabase, EXPORT_DATASETS.posts, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.comments, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.following, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.followers, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.tipsSent, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.tipsReceived, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.loginSessions, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.apiKeys, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.passkeys, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.pushSubscriptions, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.backupCodes, user.id),
      fetchAllExportRows(supabase, EXPORT_DATASETS.recoveryTokens, user.id),
    ])

    const exportData: ExportData = {
      exportedAt: new Date().toISOString(),
      profile: typedProfile,
      posts,
      comments,
      follows: {
        following: normalizeFollowRows(following, 'following'),
        followers: normalizeFollowRows(followers, 'follower'),
      },
      tips: {
        sent: normalizeTipRows(tipsSent, 'sent'),
        received: normalizeTipRows(tipsReceived, 'received'),
      },
      account: {
        login_sessions: loginSessions,
        api_keys: apiKeys,
        passkeys,
        push_subscriptions: pushSubscriptions,
        backup_codes: backupCodes,
        recovery_tokens: recoveryTokens,
      },
    }

    // Serialize and construct the response before consuming the durable
    // cooldown. Then atomically claim it; concurrent requests may both read,
    // but only one can return a download.
    const response = new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="ranking-arena-export-${exportData.exportedAt.slice(0, 10)}.json"`,
        'Cache-Control': 'private, no-store, max-age=0',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
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
