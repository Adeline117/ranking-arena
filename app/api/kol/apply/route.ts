import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export const dynamic = 'force-dynamic'

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function POST(req: NextRequest) {
  const rateLimitResp = await checkRateLimit(req, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const supabase = getSupabase()
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Please log in first' }, { status: 401 })
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7))
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    const body = await req.json()
    const { tier, platform, platform_handle, follower_count, description, proof_url } = body

    if (!tier || !['tier1', 'tier2', 'tier3'].includes(tier)) {
      return NextResponse.json({ error: 'Please select a valid tier' }, { status: 400 })
    }

    // Check for existing pending application
    const { data: existing } = await supabase
      .from('kol_applications')
      .select('id')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) {
      return NextResponse.json({ error: 'You already have a pending application' }, { status: 409 })
    }

    const { data, error } = await supabase
      .from('kol_applications')
      .insert({
        user_id: user.id,
        tier,
        platform: platform || null,
        platform_handle: platform_handle || null,
        follower_count: follower_count ? parseInt(follower_count) : null,
        description: description || null,
        proof_url: proof_url || null,
      })
      .select()
      .single()

    if (error) {
      logger.error('KOL application error:', error)
      return NextResponse.json({ error: 'Submission failed, please try again later' }, { status: 500 })
    }

    return NextResponse.json({ success: true, data })
  } catch (err) {
    logger.error('KOL apply error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
