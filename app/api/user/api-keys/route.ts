import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { withAuth } from '@/lib/api/middleware'

const MAX_KEYS_PER_USER = 5

/**
 * GET /api/user/api-keys
 * List the authenticated user's API keys.
 */
export const GET = withAuth(
  async ({ user, supabase }) => {
    const { data, error } = await supabase
      .from('api_keys')
      .select(
        'id, name, key, tier, daily_limit, request_count_today, active, last_used_at, created_at, revoked_at'
      )
      .eq('user_id', user!.id)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch API keys' }, { status: 500 })
    }

    // Mask keys in list view — only show prefix + last 4
    const masked = (data ?? []).map((k) => ({
      ...k,
      key: k.key.slice(0, 7) + '...' + k.key.slice(-4),
    }))

    const res = NextResponse.json({ data: masked })
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

    // Check key limit
    const { count } = await supabase
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user!.id)
      .eq('active', true)

    if ((count ?? 0) >= MAX_KEYS_PER_USER) {
      return NextResponse.json(
        { error: `Maximum ${MAX_KEYS_PER_USER} active keys allowed` },
        { status: 400 }
      )
    }

    // Generate key: arena_sk_ + 32 random hex chars
    const key = 'arena_sk_' + randomBytes(16).toString('hex')

    const { data, error } = await supabase
      .from('api_keys')
      .insert({ user_id: user!.id, key, name, tier: 'free', daily_limit: 100 })
      .select('id, name, key, tier, daily_limit, created_at')
      .single()

    if (error) {
      // Handle unique violation (extremely unlikely with 16 random bytes)
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'Key generation conflict, please retry' },
          { status: 409 }
        )
      }
      return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 })
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

    const { data, error } = await supabase
      .from('api_keys')
      .update({ active: false, revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user!.id)
      .select('id')
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Key not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  },
  { name: 'api-keys-revoke', rateLimit: 'authenticated' }
)
