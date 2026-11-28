/**
 * 数据仪表盘统计 API
 * GET /api/admin/stats - 获取关键统计数据
 */

import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { readServedRankingSources } from '@/lib/data/served-ranking-sources'

const logger = createLogger('admin-stats')

export const dynamic = 'force-dynamic'

export const GET = withAdminAuth(
  async ({ supabase }) => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)

    // Run ALL count queries in parallel instead of sequential (14 queries → 1 round-trip)
    const [
      { count: totalUsers },
      { count: newUsersToday },
      { count: newUsersYesterday },
      { count: bannedUsers },
      { count: totalPosts },
      { count: newPostsToday },
      { count: newPostsYesterday },
      { count: totalComments },
      { count: newCommentsToday },
      { count: pendingReports },
      { count: reportsThisWeek },
      { count: totalGroups },
      { count: pendingGroupApplications },
      { count: totalTraders },
      { count: snapshots24h },
      // Admin dashboard numbers — approximate is fine. Estimated counts
      // avoid stalling the dashboard when the DB is under cron load.
      // content_reports pending count kept exact — it's a moderation queue
      // actionable by staff where "3 vs 3000" matters.
    ] = await Promise.all([
      supabase.from('user_profiles').select('id', { count: 'estimated', head: true }),
      supabase
        .from('user_profiles')
        .select('id', { count: 'estimated', head: true })
        .gte('created_at', today.toISOString()),
      supabase
        .from('user_profiles')
        .select('id', { count: 'estimated', head: true })
        .gte('created_at', yesterday.toISOString())
        .lt('created_at', today.toISOString()),
      supabase
        .from('user_profiles')
        .select('id', { count: 'estimated', head: true })
        .not('banned_at', 'is', null),
      supabase.from('posts').select('id', { count: 'estimated', head: true }),
      supabase
        .from('posts')
        .select('id', { count: 'estimated', head: true })
        .gte('created_at', today.toISOString()),
      supabase
        .from('posts')
        .select('id', { count: 'estimated', head: true })
        .gte('created_at', yesterday.toISOString())
        .lt('created_at', today.toISOString()),
      supabase.from('comments').select('id', { count: 'estimated', head: true }),
      supabase
        .from('comments')
        .select('id', { count: 'estimated', head: true })
        .gte('created_at', today.toISOString()),
      // KEEP 'exact' — moderation queue actionable by staff
      supabase
        .from('content_reports')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
      supabase
        .from('content_reports')
        .select('id', { count: 'estimated', head: true })
        .gte('created_at', weekAgo.toISOString()),
      supabase.from('groups').select('id', { count: 'estimated', head: true }),
      // KEEP 'exact' — moderation queue
      supabase
        .from('group_applications')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
      supabase
        .from('leaderboard_ranks')
        .select('source_trader_id', { count: 'estimated', head: true })
        .eq('season_id', '90D'),
      // Migrated off retiring trader_latest → leaderboard_ranks (ranked traders
      // scored in the last 24h, computed_at).
      supabase
        .from('leaderboard_ranks')
        .select('source_trader_id', { count: 'estimated', head: true })
        .gte('computed_at', yesterday.toISOString()),
    ])

    // Scraper health and traders per platform, from the sources the public
    // board is serving (issue #554). The count cache this used to read counts
    // the raw rank table and keeps listing sources the board has dropped.
    const scraperHealth = { fresh: 0, stale: 0, critical: 0 }
    const tradersByPlatform: Record<string, number> = {}
    try {
      const nowMs = Date.now()
      for (const served of await readServedRankingSources(supabase)) {
        const ageHours = (nowMs - new Date(served.recordedAt).getTime()) / (1000 * 60 * 60)
        if (ageHours < 12) scraperHealth.fresh++
        else if (ageHours < 24) scraperHealth.stale++
        else scraperHealth.critical++
        tradersByPlatform[served.source] = served.publishedCount
      }
    } catch (e: unknown) {
      logger.error('Served ranking sources unavailable', { error: e })
    }

    return apiSuccess({
      stats: {
        users: {
          total: totalUsers || 0,
          newToday: newUsersToday || 0,
          newYesterday: newUsersYesterday || 0,
          banned: bannedUsers || 0,
        },
        posts: {
          total: totalPosts || 0,
          newToday: newPostsToday || 0,
          newYesterday: newPostsYesterday || 0,
        },
        comments: {
          total: totalComments || 0,
          newToday: newCommentsToday || 0,
        },
        reports: {
          pending: pendingReports || 0,
          thisWeek: reportsThisWeek || 0,
        },
        groups: {
          total: totalGroups || 0,
          pendingApplications: pendingGroupApplications || 0,
        },
        scraperHealth,
        traders: {
          total: totalTraders || 0,
          byPlatform: tradersByPlatform,
          snapshots24h: snapshots24h || 0,
        },
      },
      generatedAt: now.toISOString(),
    })
  },
  { name: 'admin-stats' }
)
