/**
 * POST /api/quiz/save — Save quiz result to Supabase
 *
 * Fire-and-forget from the client. Accepts anonymous results (no auth required).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'

const VALID_TYPES = new Set(['sniper', 'scalper', 'whale', 'analyst', 'contrarian', 'hodler', 'degen', 'strategist'])

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { sessionId, primaryType, secondaryType, matchPercent, scores, answers } = body

    // Validate required fields
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 100) {
      return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 })
    }
    if (!primaryType || !VALID_TYPES.has(primaryType)) {
      return NextResponse.json({ error: 'Invalid primaryType' }, { status: 400 })
    }
    if (secondaryType && !VALID_TYPES.has(secondaryType)) {
      return NextResponse.json({ error: 'Invalid secondaryType' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Try to extract user_id from auth header (optional)
    let userId: string | null = null
    const authHeader = request.headers.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const { data } = await supabase.auth.getUser(token)
      if (data?.user) userId = data.user.id
    }

    // quiz_results table may not be in generated types yet (migration pending)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from('quiz_results').insert({
      session_id: sessionId,
      user_id: userId,
      primary_type: primaryType,
      secondary_type: secondaryType || null,
      match_percent: typeof matchPercent === 'number' ? matchPercent : null,
      scores: scores || null,
      answers: answers || null,
      language: request.headers.get('accept-language')?.split(',')[0]?.split('-')[0] || 'en',
    })

    if (error) {
      // Log but don't fail — this is analytics, not critical
      console.error('[quiz/save] Insert error:', error.message)
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
