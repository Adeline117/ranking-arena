/**
 * 数据仪表盘统计 API
 * GET /api/admin/stats - 获取关键统计数据
 */

import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

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
      { count: totalLibraryItems },
      { count: libraryWithPdf },
    ] = await Promise.all([
      supabase.from('user_profiles').select('id', { count: 'exact', head: true }),
      supabase.from('user_profiles').select('id', { count: 'exact', head: true }).gte('created_at', today.toISOString()),
      supabase.from('user_profiles').select('id', { count: 'exact', head: true }).gte('created_at', yesterday.toISOString()).lt('created_at', today.toISOString()),
      supabase.from('user_profiles').select('id', { count: 'exact', head: true }).not('banned_at', 'is', null),
      supabase.from('posts').select('id', { count: 'exact', head: true }),
      supabase.from('posts').select('id', { count: 'exact', head: true }).gte('created_at', today.toISOString()),
      supabase.from('posts').select('id', { count: 'exact', head: true }).gte('created_at', yesterday.toISOString()).lt('created_at', today.toISOString()),
      supabase.from('comments').select('id', { count: 'exact', head: true }),
      supabase.from('comments').select('id', { count: 'exact', head: true }).gte('created_at', today.toISOString()),
      supabase.from('content_reports').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('content_reports').select('id', { count: 'exact', head: true }).gte('created_at', weekAgo.toISOString()),
      supabase.from('groups').select('id', { count: 'exact', head: true }),
      supabase.from('group_applications').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('leaderboard_ranks').select('source_trader_id', { count: 'exact', head: true }).eq('season_id', '90D'),
      supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).gte('created_at', yesterday.toISOString()),
      supabase.from('library_items').select('id', { count: 'exact', head: true }),
      supabase.from('library_items').select('id', { count: 'exact', head: true }).not('pdf_url', 'is', null),
    ])

    // Scraper health — use leaderboard_count_cache instead of full table scan
    const scraperHealth = { fresh: 0, stale: 0, critical: 0 }
    try {
      const { data: platformFreshness } = await supabase
        .from('leaderboard_count_cache')
        .select('source, updated_at')
        .neq('source', '_all')

      if (platformFreshness) {
        const nowMs = Date.now()
        for (const p of platformFreshness) {
          const ageHours = (nowMs - new Date(p.updated_at).getTime()) / (1000 * 60 * 60)
          if (ageHours < 12) scraperHealth.fresh++
          else if (ageHours < 24) scraperHealth.stale++
          else scraperHealth.critical++
        }
      }
    } catch (e: unknown) {
      logger.warn('Error computing scraper health', { error: e })
    }

    // Traders per platform — use leaderboard_count_cache instead of full table scan
    const tradersByPlatform: Record<string, number> = {}
    try {
      const { data: countCache } = await supabase
        .from('leaderboard_count_cache')
        .select('source, count')
        .neq('source', '_all')
      if (countCache) {
        for (const row of countCache) {
          tradersByPlatform[row.source] = row.count
        }
      }
    } catch (e: unknown) {
      logger.warn('Error fetching platform counts', { error: e })
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
        library: {
          total: totalLibraryItems || 0,
          withPdf: libraryWithPdf || 0,
        },
      },
      generatedAt: now.toISOString(),
    })
  },
  { name: 'admin-stats' }
)
