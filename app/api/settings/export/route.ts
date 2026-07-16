/**
 * Data Export API
 * POST: Export the currently supported portable user datasets as JSON
 * Rate limited to 1 export per 24 hours
 */

import { NextRequest, NextResponse } from 'next/server'
import { getProvisioningAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import {
  DataExportReadError,
  DataExportTooLargeError,
  fetchAllExportRows,
  fetchAllExportRowsByCursor,
  projectExportRecord,
  type CursorExportDataset,
  type ExportDataset,
} from '@/lib/account/data-export'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Allow up to 60s for large exports

const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24 hours

interface ExportDatasetManifest {
  name: string
  status: 'complete'
  row_count: number
}

interface ExportData {
  exportedAt: string
  manifest: {
    schema_version: '1'
    scope: 'supported_portable_datasets'
    consistency: 'best_effort_keyset'
    started_at: string
    completed_at: string
    datasets: ExportDatasetManifest[]
  }
  profile: Record<string, unknown>
  posts: unknown[]
  comments: unknown[]
  follows: {
    following: unknown[]
    followers: unknown[]
  }
  blocks: {
    outgoing: unknown[]
  }
  tips: {
    sent: unknown[]
    received: unknown[]
  }
  interactions: {
    post_likes: unknown[]
    post_votes: unknown[]
  }
  settings: {
    preferences: Record<string, unknown> | null
  }
  account: {
    bindings: unknown[]
    login_sessions: unknown[]
    api_keys: unknown[]
    passkeys: unknown[]
    push_subscriptions: unknown[]
    backup_codes: unknown[]
    recovery_tokens: unknown[]
  }
}

type UserProfileColumn = keyof Database['public']['Tables']['user_profiles']['Row']

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
] as const satisfies readonly UserProfileColumn[]

const PROFILE_QUERY_COLUMNS = [
  ...PROFILE_EXPORT_COLUMNS,
  'last_export_at',
] as const satisfies readonly UserProfileColumn[]

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

const PREFERENCES_EXPORT_DATASET = {
  name: 'settings.preferences',
  table: 'user_preferences',
  selectColumns: [
    'user_id',
    'watched_traders',
    'email_notifications',
    'push_notifications',
    'ranking_change_threshold',
    'created_at',
    'updated_at',
  ],
  ownerPredicate: {
    column: 'user_id',
    operator: 'eq',
    valueType: 'uuid',
  },
  cursor: {
    order: 'asc',
    columns: [{ column: 'user_id', valueType: 'uuid' }],
  },
} satisfies CursorExportDataset

const ACCOUNT_BINDINGS_EXPORT_DATASET = {
  name: 'account.bindings',
  table: 'account_bindings',
  selectColumns: ['platform', 'account_id', 'created_at'],
  ownerPredicate: {
    column: 'user_id',
    operator: 'eq',
    valueType: 'uuid',
  },
  cursor: {
    order: 'asc',
    columns: [{ column: 'platform', valueType: 'string' }],
  },
} satisfies CursorExportDataset

const OUTGOING_BLOCKS_EXPORT_DATASET = {
  name: 'blocks.outgoing',
  table: 'blocked_users',
  selectColumns: ['blocked_id', 'created_at'],
  ownerPredicate: {
    column: 'blocker_id',
    operator: 'eq',
    valueType: 'uuid',
  },
  cursor: {
    order: 'asc',
    columns: [{ column: 'blocked_id', valueType: 'uuid' }],
  },
} satisfies CursorExportDataset

const POST_LIKES_EXPORT_DATASET = {
  name: 'interactions.post_likes',
  table: 'post_likes',
  selectColumns: ['post_id', 'reaction_type', 'created_at'],
  ownerPredicate: {
    column: 'user_id',
    operator: 'eq',
    valueType: 'uuid',
  },
  cursor: {
    order: 'asc',
    columns: [{ column: 'post_id', valueType: 'uuid' }],
  },
} satisfies CursorExportDataset

const POST_VOTES_EXPORT_DATASET = {
  name: 'interactions.post_votes',
  table: 'post_votes',
  selectColumns: ['post_id', 'choice', 'created_at'],
  ownerPredicate: {
    column: 'user_id',
    operator: 'eq',
    valueType: 'uuid',
  },
  cursor: {
    order: 'asc',
    columns: [{ column: 'post_id', valueType: 'uuid' }],
  },
} satisfies CursorExportDataset

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

function normalizePreferences(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  if (rows.length === 0) return null
  if (rows.length !== 1) {
    throw new DataExportReadError(
      PREFERENCES_EXPORT_DATASET.name,
      new Error('Expected at most one user preferences row')
    )
  }

  const row = rows[0]
  return {
    watched_traders: row.watched_traders,
    email_notifications: row.email_notifications,
    push_notifications: row.push_notifications,
    ranking_change_threshold: row.ranking_change_threshold,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function normalizeAccountBindings(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    platform: row.platform,
    account_id: row.account_id,
    created_at: row.created_at,
  }))
}

function normalizeOutgoingBlocks(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    blocked_user_id: row.blocked_id,
    created_at: row.created_at,
  }))
}

function normalizePostLikes(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    post_id: row.post_id,
    reaction_type: row.reaction_type,
    created_at: row.created_at,
  }))
}

function normalizePostVotes(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    post_id: row.post_id,
    choice: row.choice,
    created_at: row.created_at,
  }))
}

function completedDataset(name: string, rowCount: number): ExportDatasetManifest {
  return { name, status: 'complete', row_count: rowCount }
}

function parseStoredTimestamp(value: string, field: string): number {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${field} timestamp`)
  return timestamp
}

function readProfileLastExportAt(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object' || !Object.hasOwn(profile, 'last_export_at')) {
    throw new DataExportReadError('profile', new Error('Missing last_export_at value'))
  }
  const value = Reflect.get(profile, 'last_export_at')
  if (value === null || typeof value === 'string') return value
  throw new DataExportReadError('profile', new Error('Invalid last_export_at value'))
}

async function claimExportCooldown(
  supabase: SupabaseClient<Database>,
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

    const supabase = getSupabaseAdmin()

    // Profile provisioning is an authentication invariant. Missing rows fail
    // closed: without one there is no durable tuple on which to serialize the
    // 24-hour cooldown.
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select(PROFILE_QUERY_COLUMNS.join(','))
      .eq('id', user.id)
      .maybeSingle()

    if (profileError || !profile) {
      logger.error('[Export] Profile fetch error:', profileError)
      return NextResponse.json({ error: 'Profile provisioning is incomplete' }, { status: 503 })
    }

    const lastExportAt = readProfileLastExportAt(profile)
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

    const exportStartedAt = new Date().toISOString()

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
      preferences,
      accountBindings,
      outgoingBlocks,
      postLikes,
      postVotes,
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
      fetchAllExportRowsByCursor(supabase, PREFERENCES_EXPORT_DATASET, user.id),
      fetchAllExportRowsByCursor(supabase, ACCOUNT_BINDINGS_EXPORT_DATASET, user.id),
      fetchAllExportRowsByCursor(supabase, OUTGOING_BLOCKS_EXPORT_DATASET, user.id),
      fetchAllExportRowsByCursor(supabase, POST_LIKES_EXPORT_DATASET, user.id),
      fetchAllExportRowsByCursor(supabase, POST_VOTES_EXPORT_DATASET, user.id),
    ])

    const normalizedFollowing = normalizeFollowRows(following, 'following')
    const normalizedFollowers = normalizeFollowRows(followers, 'follower')
    const normalizedOutgoingBlocks = normalizeOutgoingBlocks(outgoingBlocks)
    const normalizedTipsSent = normalizeTipRows(tipsSent, 'sent')
    const normalizedTipsReceived = normalizeTipRows(tipsReceived, 'received')
    const normalizedPostLikes = normalizePostLikes(postLikes)
    const normalizedPostVotes = normalizePostVotes(postVotes)
    const normalizedPreferences = normalizePreferences(preferences)
    const normalizedAccountBindings = normalizeAccountBindings(accountBindings)
    const exportedAt = new Date().toISOString()
    const exportData: ExportData = {
      exportedAt,
      manifest: {
        schema_version: '1',
        scope: 'supported_portable_datasets',
        consistency: 'best_effort_keyset',
        started_at: exportStartedAt,
        completed_at: exportedAt,
        datasets: [
          completedDataset('profile', 1),
          completedDataset('posts', posts.length),
          completedDataset('comments', comments.length),
          completedDataset('follows.following', following.length),
          completedDataset('follows.followers', followers.length),
          completedDataset('blocks.outgoing', outgoingBlocks.length),
          completedDataset('tips.sent', tipsSent.length),
          completedDataset('tips.received', tipsReceived.length),
          completedDataset('interactions.post_likes', postLikes.length),
          completedDataset('interactions.post_votes', postVotes.length),
          completedDataset('settings.preferences', preferences.length),
          completedDataset('account.bindings', accountBindings.length),
          completedDataset('account.login_sessions', loginSessions.length),
          completedDataset('account.api_keys', apiKeys.length),
          completedDataset('account.passkeys', passkeys.length),
          completedDataset('account.push_subscriptions', pushSubscriptions.length),
          completedDataset('account.backup_codes', backupCodes.length),
          completedDataset('account.recovery_tokens', recoveryTokens.length),
        ],
      },
      profile: typedProfile,
      posts,
      comments,
      follows: {
        following: normalizedFollowing,
        followers: normalizedFollowers,
      },
      blocks: {
        outgoing: normalizedOutgoingBlocks,
      },
      tips: {
        sent: normalizedTipsSent,
        received: normalizedTipsReceived,
      },
      interactions: {
        post_likes: normalizedPostLikes,
        post_votes: normalizedPostVotes,
      },
      settings: {
        preferences: normalizedPreferences,
      },
      account: {
        bindings: normalizedAccountBindings,
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
