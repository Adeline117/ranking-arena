import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { success as apiSuccess } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { BASE_URL } from '@/lib/constants/urls'

const logger = createLogger('referral-api')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const
const QUALIFIED_PAGE_SIZE = 500
const MAX_QUALIFIED_ROWS = 100_000
const ADVOCATE_REWARD_TYPE = 'advocate_milestone'
const APPLICABLE_REFERRAL_CODE = /^[A-Za-z0-9_-]{2,64}$/

const UuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const TimestampSchema = z.string().datetime({ offset: true })
const CreateCodeSchema = z.object({ action: z.literal('create') }).strict()
const ProfileSchema = z
  .object({
    id: UuidSchema,
    handle: z.string().min(1).max(128),
    referral_code: z.string().nullable(),
  })
  .strict()
const AttributionRowSchema = z
  .object({
    id: UuidSchema,
    signup_ip_hash: z.string().min(1).max(256).nullable(),
  })
  .strict()
const RewardRowSchema = z
  .object({
    id: UuidSchema,
    referrer_id: UuidSchema,
    reward_type: z.literal(ADVOCATE_REWARD_TYPE),
    granted_days: z.number().int().min(1).max(3650),
    created_at: TimestampSchema,
    entitlement_granted_at: TimestampSchema.nullable(),
  })
  .strict()
const EntitlementGrantSchema = z
  .object({
    id: UuidSchema,
    user_id: UuidSchema,
    source: z.literal('referral'),
    source_key: z.string().min(1).max(255),
    grant_kind: z.literal('days'),
    granted_days: z.number().int().min(1).max(3650),
    granted_at: TimestampSchema,
    starts_at: TimestampSchema,
    expires_at: TimestampSchema,
    revoked_at: TimestampSchema.nullable(),
  })
  .strict()
const CodeMutationRowSchema = z
  .object({ id: UuidSchema, referral_code: z.string().regex(/^ra_[0-9a-f]{32}$/) })
  .strict()

type AdminClient = SupabaseClient<Database>
type AdvocateRewardResponse = {
  reward_id: string | null
  status: 'not_granted' | 'pending' | 'scheduled' | 'active' | 'expired' | 'revoked'
  granted_days: number | null
  entitlement_granted_at: string | null
  entitlement_starts_at: string | null
  entitlement_expires_at: string | null
  entitlement_revoked_at: string | null
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function noStore<T extends NextResponse>(response: T): T {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(name, value)
  return response
}

function referralLink(code: string): string {
  return `${BASE_URL}/?ref=${encodeURIComponent(code)}`
}

function csrfRejected(request: NextRequest): NextResponse | null {
  const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
  const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
  if (!validateCsrfToken(cookieToken, headerToken)) {
    return json({ error: 'CSRF validation failed' }, 403)
  }
  return null
}

async function countQualifiedDistinctReferrals(
  supabase: AdminClient,
  ownerId: string
): Promise<number> {
  const identities = new Set<string>()
  let rowsRead = 0
  let lastId: string | null = null

  while (true) {
    let query = supabase
      .from('referral_attributions')
      .select('id, signup_ip_hash')
      .eq('referrer_id', ownerId)
      .not('qualified_at', 'is', null)
      .order('id', { ascending: true })
      .limit(QUALIFIED_PAGE_SIZE)
    if (lastId) query = query.gt('id', lastId)

    const { data, error } = await query
    if (error) throw new Error(`qualified referral query failed: ${error.code ?? 'unknown'}`)
    if (!Array.isArray(data)) throw new Error('qualified referral query returned invalid rows')
    if (data.length > QUALIFIED_PAGE_SIZE) {
      throw new Error('qualified referral query exceeded its page boundary')
    }

    for (const rawRow of data) {
      const parsed = AttributionRowSchema.safeParse(rawRow)
      if (!parsed.success || (lastId !== null && parsed.data.id <= lastId)) {
        throw new Error('qualified referral query returned malformed ordering')
      }
      lastId = parsed.data.id
      identities.add(parsed.data.signup_ip_hash ?? `row:${parsed.data.id}`)
      rowsRead += 1
      if (rowsRead > MAX_QUALIFIED_ROWS) {
        throw new Error('qualified referral query exceeded its safety boundary')
      }
    }

    if (data.length < QUALIFIED_PAGE_SIZE) return identities.size
  }
}

async function readAdvocateReward(
  supabase: AdminClient,
  ownerId: string
): Promise<AdvocateRewardResponse> {
  const { data: rawReward, error: rewardError } = await supabase
    .from('referral_rewards')
    .select('id, referrer_id, reward_type, granted_days, created_at, entitlement_granted_at')
    .eq('referrer_id', ownerId)
    .eq('reward_type', ADVOCATE_REWARD_TYPE)
    .maybeSingle()
  if (rewardError) throw new Error(`referral reward query failed: ${rewardError.code ?? 'unknown'}`)
  if (rawReward === null) {
    return {
      reward_id: null,
      status: 'not_granted',
      granted_days: null,
      entitlement_granted_at: null,
      entitlement_starts_at: null,
      entitlement_expires_at: null,
      entitlement_revoked_at: null,
    }
  }

  const parsedReward = RewardRowSchema.safeParse(rawReward)
  if (!parsedReward.success || parsedReward.data.referrer_id !== ownerId) {
    throw new Error('referral reward query returned malformed owner identity')
  }
  const reward = parsedReward.data

  const { data: rawGrant, error: grantError } = await supabase
    .from('pro_entitlement_grants')
    .select(
      'id, user_id, source, source_key, grant_kind, granted_days, granted_at, starts_at, expires_at, revoked_at'
    )
    .eq('source', 'referral')
    .eq('source_key', `advocate:${reward.id}`)
    .maybeSingle()
  if (grantError) {
    throw new Error(`referral entitlement query failed: ${grantError.code ?? 'unknown'}`)
  }

  if (reward.entitlement_granted_at === null) {
    if (rawGrant !== null) throw new Error('pending referral reward has an inconsistent grant')
    return {
      reward_id: reward.id,
      status: 'pending',
      granted_days: reward.granted_days,
      entitlement_granted_at: null,
      entitlement_starts_at: null,
      entitlement_expires_at: null,
      entitlement_revoked_at: null,
    }
  }

  const parsedGrant = EntitlementGrantSchema.safeParse(rawGrant)
  if (!parsedGrant.success) throw new Error('granted referral reward is missing its entitlement')
  const grant = parsedGrant.data
  if (
    grant.user_id !== ownerId ||
    grant.source_key !== `advocate:${reward.id}` ||
    grant.granted_days !== reward.granted_days ||
    Date.parse(grant.granted_at) !== Date.parse(reward.created_at)
  ) {
    throw new Error('referral entitlement contradicted its durable reward marker')
  }

  const now = Date.now()
  const status =
    grant.revoked_at !== null
      ? 'revoked'
      : Date.parse(grant.starts_at) > now
        ? 'scheduled'
        : Date.parse(grant.expires_at) <= now
          ? 'expired'
          : 'active'

  return {
    reward_id: reward.id,
    status,
    granted_days: reward.granted_days,
    entitlement_granted_at: reward.entitlement_granted_at,
    entitlement_starts_at: grant.starts_at,
    entitlement_expires_at: grant.expires_at,
    entitlement_revoked_at: grant.revoked_at,
  }
}

/** GET /api/referral — return the authenticated owner's qualified referral truth. */
export async function GET(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
    if (rateLimitResponse) return noStore(rateLimitResponse)

    const user = await getAuthUser(request)
    const ownerId = UuidSchema.safeParse(user?.id)
    if (!user || !ownerId.success) return json({ error: 'Unauthorized' }, 401)

    const supabase = getSupabaseAdmin()
    const { data: rawProfile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, handle, referral_code')
      .eq('id', ownerId.data)
      .maybeSingle()
    if (profileError) throw new Error(`referral profile query failed: ${profileError.code}`)
    if (rawProfile === null) return json({ error: 'Profile not found' }, 404)

    const parsedProfile = ProfileSchema.safeParse(rawProfile)
    if (!parsedProfile.success || parsedProfile.data.id !== ownerId.data) {
      throw new Error('referral profile query returned malformed owner identity')
    }
    const profile = parsedProfile.data
    if (profile.referral_code !== null && !APPLICABLE_REFERRAL_CODE.test(profile.referral_code)) {
      throw new Error('stored referral code is incompatible with attribution')
    }

    const [qualifiedReferralCount, advocateReward] = await Promise.all([
      countQualifiedDistinctReferrals(supabase, ownerId.data),
      readAdvocateReward(supabase, ownerId.data),
    ])

    const code =
      profile.referral_code ??
      (APPLICABLE_REFERRAL_CODE.test(profile.handle) ? profile.handle : null)
    const codeSource = profile.referral_code ? 'custom' : code ? 'handle' : 'none'

    return noStore(
      apiSuccess({
        referral: {
          owner_id: ownerId.data,
          referral_code: code,
          referral_link: code ? referralLink(code) : null,
          code_source: codeSource,
          qualified_referral_count: qualifiedReferralCount,
          advocate_reward: advocateReward,
        },
      })
    )
  } catch (error) {
    logger.error('Referral GET failed', { error })
    return json({ error: 'Failed to load referral data' }, 500)
  }
}

/**
 * POST /api/referral — create one permanent custom code.
 *
 * Regeneration is deliberately unsupported: the current schema has no durable
 * alias/history table, so replacing an existing custom code would silently
 * invalidate shared links and could later reassign their meaning.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return noStore(rateLimitResponse)

    const user = await getAuthUser(request)
    const ownerId = UuidSchema.safeParse(user?.id)
    if (!user || !ownerId.success) return json({ error: 'Unauthorized' }, 401)

    const csrfResponse = csrfRejected(request)
    if (csrfResponse) return csrfResponse

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }
    if (!CreateCodeSchema.safeParse(rawBody).success) {
      return json({ error: 'Invalid referral code request' }, 400)
    }

    // 128 random bits and a 35-character namespace make the code impossible to
    // collide with the database's <=30-character handle namespace.
    const code = `ra_${crypto.randomBytes(16).toString('hex')}`
    const supabase = getSupabaseAdmin()
    const { data: rawMutation, error: mutationError } = await supabase
      .from('user_profiles')
      .update({ referral_code: code })
      .eq('id', ownerId.data)
      .is('referral_code', null)
      .select('id, referral_code')
      .single()

    if (mutationError) {
      if (mutationError.code === 'PGRST116') {
        return json({ error: 'A permanent referral code already exists' }, 409)
      }
      if (mutationError.code === '23505') {
        return json({ error: 'Referral code collision; retry safely' }, 409)
      }
      throw new Error(`referral code mutation failed: ${mutationError.code ?? 'unknown'}`)
    }

    const parsedMutation = CodeMutationRowSchema.safeParse(rawMutation)
    if (
      !parsedMutation.success ||
      parsedMutation.data.id !== ownerId.data ||
      parsedMutation.data.referral_code !== code
    ) {
      throw new Error('referral code mutation returned an invalid acknowledgement')
    }

    return noStore(
      apiSuccess(
        {
          mutation: {
            action: 'create',
            owner_id: ownerId.data,
            referral_code: code,
            referral_link: referralLink(code),
            code_source: 'custom',
          },
        },
        201
      )
    )
  } catch (error) {
    logger.error('Referral POST failed', { error })
    return json({ error: 'Failed to create referral code' }, 500)
  }
}
