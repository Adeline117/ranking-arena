import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { withAuth } from '@/lib/api/middleware'

const MAX_KEYS_PER_USER = 5
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const API_KEY_PATTERN = /^arena_sk_[0-9a-f]{32}$/
const CREATE_ACK_KEYS = ['created_at', 'daily_limit', 'id', 'key', 'name', 'tier'].sort()
const API_KEY_DAILY_LIMITS = {
  free: 100,
  starter: 10_000,
  pro: 0,
} as const

type ApiKeyTier = keyof typeof API_KEY_DAILY_LIMITS

type StoredApiKey = {
  id: string
  user_id: string
  name: string
  key: string
  tier: ApiKeyTier
  daily_limit: number
  request_count_today: number
  active: boolean
  last_used_at: string | null
  created_at: string
  revoked_at: string | null
}

function isTimestampOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
}

function parseStoredApiKey(value: unknown, expectedUserId: string): StoredApiKey | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const tier = row.tier
  if (tier !== 'free' && tier !== 'starter' && tier !== 'pro') return null

  if (
    typeof row.id !== 'string' ||
    !UUID_PATTERN.test(row.id) ||
    row.user_id !== expectedUserId ||
    typeof row.name !== 'string' ||
    row.name !== row.name.trim() ||
    row.name.length < 1 ||
    row.name.length > 50 ||
    typeof row.key !== 'string' ||
    !API_KEY_PATTERN.test(row.key) ||
    row.daily_limit !== API_KEY_DAILY_LIMITS[tier] ||
    typeof row.request_count_today !== 'number' ||
    !Number.isSafeInteger(row.request_count_today) ||
    row.request_count_today < 0 ||
    typeof row.active !== 'boolean' ||
    !isTimestampOrNull(row.last_used_at) ||
    typeof row.created_at !== 'string' ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    !isTimestampOrNull(row.revoked_at)
  ) {
    return null
  }

  return row as StoredApiKey
}

function isExactCreateAcknowledgement(
  value: unknown,
  expected: { key: string; name: string }
): value is {
  id: string
  name: string
  key: string
  tier: 'free' | 'starter' | 'pro'
  daily_limit: number
  created_at: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const acknowledgement = value as Record<string, unknown>
  const keys = Object.keys(acknowledgement).sort()
  if (
    keys.length !== CREATE_ACK_KEYS.length ||
    !keys.every((key, index) => key === CREATE_ACK_KEYS[index])
  ) {
    return false
  }

  const expectedDailyLimit =
    acknowledgement.tier === 'free'
      ? 100
      : acknowledgement.tier === 'starter'
        ? 10_000
        : acknowledgement.tier === 'pro'
          ? 0
          : null
  return (
    typeof acknowledgement.id === 'string' &&
    UUID_PATTERN.test(acknowledgement.id) &&
    acknowledgement.name === expected.name &&
    acknowledgement.key === expected.key &&
    API_KEY_PATTERN.test(expected.key) &&
    expectedDailyLimit !== null &&
    acknowledgement.daily_limit === expectedDailyLimit &&
    typeof acknowledgement.created_at === 'string' &&
    Number.isFinite(Date.parse(acknowledgement.created_at))
  )
}

/**
 * GET /api/user/api-keys
 * List the authenticated user's API keys.
 */
export const GET = withAuth(
  async ({ user, supabase }) => {
    const [keysResult, profileResult] = await Promise.all([
      supabase
        .from('api_keys')
        .select(
          'id, user_id, name, key, tier, daily_limit, request_count_today, active, last_used_at, created_at, revoked_at'
        )
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('user_profiles')
        .select('api_tier, api_stripe_subscription_id')
        .eq('id', user!.id)
        .maybeSingle(),
    ])

    if (
      keysResult.error ||
      profileResult.error ||
      !Array.isArray(keysResult.data) ||
      !profileResult.data ||
      (profileResult.data.api_tier !== 'free' &&
        profileResult.data.api_tier !== 'starter' &&
        profileResult.data.api_tier !== 'pro') ||
      (profileResult.data.api_stripe_subscription_id !== null &&
        typeof profileResult.data.api_stripe_subscription_id !== 'string')
    ) {
      return NextResponse.json({ error: 'Failed to fetch API keys' }, { status: 500 })
    }

    const storedKeys = keysResult.data.map((row) => parseStoredApiKey(row, user!.id))
    if (storedKeys.some((row) => row === null)) {
      return NextResponse.json({ error: 'Failed to fetch API keys' }, { status: 500 })
    }

    // Mask keys in list view — only show prefix + last 4
    const masked = (storedKeys as StoredApiKey[]).map(({ user_id: _userId, ...key }) => ({
      ...key,
      key: key.key.slice(0, 7) + '...' + key.key.slice(-4),
    }))

    const apiTier = profileResult.data.api_tier
    const hasStripeSubscription =
      apiTier !== 'free' &&
      typeof profileResult.data.api_stripe_subscription_id === 'string' &&
      profileResult.data.api_stripe_subscription_id.startsWith('sub_') &&
      profileResult.data.api_stripe_subscription_id.length > 'sub_'.length

    const res = NextResponse.json({
      data: masked,
      entitlement: {
        tier: apiTier,
        hasStripeSubscription,
      },
    })
    res.headers.set('Cache-Control', 'private, no-store')
    return res
  },
  { name: 'api-keys-list', rateLimit: 'authenticated' }
)

/**
 * POST /api/user/api-keys
 * Create a new API key. Body: { name?: string }
 */
export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const body = await request.json().catch(() => ({}))
    const name =
      typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 50) : 'Default'

    // Generate key: arena_sk_ + 32 random hex chars
    const key = 'arena_sk_' + randomBytes(16).toString('hex')

    // The RPC locks the profile row shared with Stripe projection, derives the
    // current entitlement in the database, and enforces the active-key limit
    // in the same transaction. A read-then-insert here can strand a paid user
    // on free quota when key creation races a webhook.
    const { data, error } = await supabase.rpc('create_user_api_key_with_current_entitlement', {
      p_user_id: user!.id,
      p_key: key,
      p_name: name,
    })

    if (error) {
      if (error.code === 'P0001' && error.message === 'maximum 5 active API keys allowed') {
        return NextResponse.json(
          { error: `Maximum ${MAX_KEYS_PER_USER} active keys allowed` },
          { status: 400 }
        )
      }
      // Handle unique violation (extremely unlikely with 16 random bytes)
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'Key generation conflict, please retry' },
          { status: 409 }
        )
      }
      return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 })
    }
    if (!isExactCreateAcknowledgement(data, { key, name })) {
      return NextResponse.json({ error: 'Failed to acknowledge API key creation' }, { status: 500 })
    }

    // Return the FULL key only on creation — user must copy it now
    return NextResponse.json({ data }, { status: 201 })
  },
  { name: 'api-keys-create', rateLimit: 'authenticated' }
)

/**
 * PATCH /api/user/api-keys
 * Revoke an API key. Body: { id: string }
 */
export const PATCH = withAuth(
  async ({ user, supabase, request }) => {
    const body = await request.json().catch(() => ({}))
    const id = body.id

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Missing key id' }, { status: 400 })
    }

    const revokedAt = new Date().toISOString()
    const { data, error } = await supabase
      .from('api_keys')
      .update({ active: false, revoked_at: revokedAt })
      .eq('id', id)
      .eq('user_id', user!.id)
      .select('id, active, revoked_at')
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Key not found' }, { status: 404 })
    }
    if (
      data.id !== id ||
      data.active !== false ||
      typeof data.revoked_at !== 'string' ||
      !Number.isFinite(Date.parse(data.revoked_at)) ||
      Date.parse(data.revoked_at) !== Date.parse(revokedAt)
    ) {
      return NextResponse.json(
        { error: 'Failed to acknowledge API key revocation' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      data: {
        id: data.id,
        active: data.active,
        revoked_at: data.revoked_at,
      },
    })
  },
  { name: 'api-keys-revoke', rateLimit: 'authenticated' }
)
