import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

// Lazy initialization to avoid build-time errors when env vars are missing
let _supabaseAdmin: SupabaseClient | null = null
function getSupabaseAdmin(): SupabaseClient {
  if (!_supabaseAdmin) {
    _supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _supabaseAdmin
}

// Exchange peer IDs between users for WebRTC signaling
// POST: register/update peer ID for a user or initiate a call signal
// GET: retrieve peer ID for a target user

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await getSupabaseAdmin().auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { action, targetUserId, peerId, callType } = body

    if (action === 'register') {
      // Register/update peer ID
      const { error } = await getSupabaseAdmin()
        .from('call_signals')
        .upsert({
          user_id: user.id,
          peer_id: peerId,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })

      if (error) {
        // Table might not exist yet - that's OK, PeerJS cloud handles signaling
        logger.warn('call_signals upsert failed (table may not exist):', error.message)
      }

      return NextResponse.json({ ok: true })
    }

    if (action === 'call') {
      // Look up target user's peer ID
      const { data: signal } = await getSupabaseAdmin()
        .from('call_signals')
        .select('peer_id')
        .eq('user_id', targetUserId)
        .single()

      return NextResponse.json({
        targetPeerId: signal?.peer_id || `ra-${targetUserId}`,
        callType: callType || 'voice',
      })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (err) {
    logger.error('Call signal error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await getSupabaseAdmin().auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const targetUserId = searchParams.get('targetUserId')

    if (!targetUserId) {
      return NextResponse.json({ error: 'targetUserId required' }, { status: 400 })
    }

    const { data: signal } = await supabaseAdmin
      .from('call_signals')
      .select('peer_id')
      .eq('user_id', targetUserId)
      .single()

    return NextResponse.json({
      peerId: signal?.peer_id || `ra-${targetUserId}`,
    })
  } catch (err) {
    logger.error('Call signal GET error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
