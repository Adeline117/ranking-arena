import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('analytics-daily')

  try {
    const supabase = getSupabaseAdmin()
    const today = new Date().toISOString().split('T')[0]

    const { count: signups } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', `${today}T00:00:00Z`)
      .lt('created_at', `${today}T23:59:59Z`)

    const { count: activeUsers } = await supabase
      .from('interactions')
      .select('user_id', { count: 'exact', head: true })
      .gte('created_at', `${today}T00:00:00Z`)

    const { count: newClaims } = await supabase
      .from('trader_claims')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', `${today}T00:00:00Z`)

    const { count: newFollows } = await supabase
      .from('trader_follows')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', `${today}T00:00:00Z`)

    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
    const row = {
      date: yesterday,
      signups: signups ?? 0,
      active_users: activeUsers ?? 0,
      new_claims: newClaims ?? 0,
      new_follows: newFollows ?? 0,
    }

    const { error } = await supabase
      .from('analytics_daily')
      .upsert(row, { onConflict: 'date' })

    if (error) {
      logger.error('[Analytics Daily] Upsert error:', error)
      return NextResponse.json({ error: 'DB error' }, { status: 500 })
    }

    await plog.success(1, row)
    return NextResponse.json({ ok: true, data: row })
  } catch (err) {
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    logger.error('[Analytics Daily] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
