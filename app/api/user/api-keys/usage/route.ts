import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'

/**
 * GET /api/user/api-keys/usage?days=30
 * Returns daily usage for all of the user's API keys over the last N days.
 */
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const days = Math.min(
      Math.max(parseInt(request.nextUrl.searchParams.get('days') || '30', 10) || 30, 1),
      90
    )

    const since = new Date()
    since.setDate(since.getDate() - days)

    // Get user's key IDs
    const { data: keys } = await supabase
      .from('api_keys')
      .select('id, name')
      .eq('user_id', user!.id)

    if (!keys || keys.length === 0) {
      return NextResponse.json({ data: { keys: [], daily: [], totals: {} } })
    }

    const keyIds = keys.map((k) => k.id)

    // Fetch daily usage
    const { data: daily, error } = await supabase
      .from('api_key_usage_daily')
      .select('api_key_id, date, request_count')
      .in('api_key_id', keyIds)
      .gte('date', since.toISOString().slice(0, 10))
      .order('date', { ascending: true })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Also include today's live counts from api_keys.request_count_today
    const { data: liveKeys } = await supabase
      .from('api_keys')
      .select('id, request_count_today')
      .in('id', keyIds)

    const today = new Date().toISOString().slice(0, 10)
    const todayEntries = (liveKeys ?? [])
      .filter((k) => k.request_count_today > 0)
      .map((k) => ({
        api_key_id: k.id,
        date: today,
        request_count: k.request_count_today,
      }))

    // Merge: daily rows + today's live counts (today's rollup may not have run yet)
    const allDaily = [...(daily ?? [])]
    for (const entry of todayEntries) {
      const existing = allDaily.find(
        (d) => d.api_key_id === entry.api_key_id && d.date === entry.date
      )
      if (existing) {
        // Take the higher value (live count is more current)
        existing.request_count = Math.max(existing.request_count, entry.request_count)
      } else {
        allDaily.push(entry)
      }
    }

    // Compute totals per key
    const totals: Record<string, number> = {}
    for (const row of allDaily) {
      totals[row.api_key_id] = (totals[row.api_key_id] || 0) + row.request_count
    }

    return NextResponse.json({
      data: {
        keys,
        daily: allDaily,
        totals,
      },
    })
  },
  { name: 'api-keys-usage', rateLimit: 'authenticated' }
)
