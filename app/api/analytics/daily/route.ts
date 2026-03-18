/**
 * Cron: Aggregate daily analytics metrics
 * Refactored to use withCron wrapper (dub.co pattern)
 */

import { withCron } from '@/lib/api/with-cron'

const handler = withCron('analytics-daily', async (_request, { supabase }) => {
  const today = new Date().toISOString().split('T')[0]

  const [{ count: signups }, { count: activeUsers }, { count: newClaims }, { count: newFollows }] = await Promise.all([
    supabase.from('user_profiles').select('id', { count: 'exact', head: true })
      .gte('created_at', `${today}T00:00:00Z`).lt('created_at', `${today}T23:59:59Z`),
    supabase.from('interactions').select('user_id', { count: 'exact', head: true })
      .gte('created_at', `${today}T00:00:00Z`),
    supabase.from('trader_claims').select('id', { count: 'exact', head: true })
      .gte('created_at', `${today}T00:00:00Z`),
    supabase.from('trader_follows').select('id', { count: 'exact', head: true })
      .gte('created_at', `${today}T00:00:00Z`),
  ])

  const row = {
    date: today,
    signups: signups ?? 0,
    active_users: activeUsers ?? 0,
    new_claims: newClaims ?? 0,
    new_follows: newFollows ?? 0,
  }

  const { error } = await supabase
    .from('analytics_daily')
    .upsert(row, { onConflict: 'date' })

  if (error) throw new Error(`DB upsert error: ${error.message}`)

  return { count: 1, ...row }
})

// Support both GET (Vercel cron) and POST (manual trigger)
export const GET = handler
export const POST = handler
