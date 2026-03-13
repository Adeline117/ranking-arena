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

    // User statistics
    const { count: totalUsers } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })

    const { count: newUsersToday } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', today.toISOString())

    const { count: newUsersYesterday } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterday.toISOString())
      .lt('created_at', today.toISOString())

    const { count: bannedUsers } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .not('banned_at', 'is', null)

    // Post statistics
    const { count: totalPosts } = await supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })

    const { count: newPostsToday } = await supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', today.toISOString())

    const { count: newPostsYesterday } = await supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterday.toISOString())
      .lt('created_at', today.toISOString())

    // Comment statistics
    const { count: totalComments } = await supabase
      .from('comments')
      .select('id', { count: 'exact', head: true })

    const { count: newCommentsToday } = await supabase
      .from('comments')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', today.toISOString())

    // Report statistics
    const { count: pendingReports } = await supabase
      .from('content_reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')

    const { count: reportsThisWeek } = await supabase
      .from('content_reports')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', weekAgo.toISOString())

    // Group statistics
    const { count: totalGroups } = await supabase
      .from('groups')
      .select('id', { count: 'exact', head: true })

    const { count: pendingGroupApplications } = await supabase
      .from('group_applications')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')

    // Scraper health summary
    const scraperHealth = { fresh: 0, stale: 0, critical: 0 }
    try {
      const { data: sources } = await supabase
        .from('trader_sources')
        .select('source, updated_at')
        .not('updated_at', 'is', null)

      if (sources) {
        const nowMs = Date.now()
        const grouped = new Map<string, Date>()
        for (const s of sources) {
          const existing = grouped.get(s.source)
          const updated = new Date(s.updated_at)
          if (!existing || updated > existing) {
            grouped.set(s.source, updated)
          }
        }
        for (const [, lastUpdate] of grouped) {
          const ageHours = (nowMs - lastUpdate.getTime()) / (1000 * 60 * 60)
          // Unified freshness SLA: fresh < 12h, stale 12-24h, critical > 24h
          if (ageHours < 12) scraperHealth.fresh++
          else if (ageHours < 24) scraperHealth.stale++
          else scraperHealth.critical++
        }
      }
    } catch (e: unknown) {
      logger.warn('Error computing scraper health', { error: e })
    }

    // Trader statistics
    const { count: totalTraders } = await supabase
      .from('trader_sources')
      .select('id', { count: 'exact', head: true })

    // Traders per platform
    const { data: tradersByPlatformRaw } = await supabase
      .from('trader_sources')
      .select('source')

    const tradersByPlatform: Record<string, number> = {}
    for (const row of tradersByPlatformRaw || []) {
      tradersByPlatform[row.source] = (tradersByPlatform[row.source] || 0) + 1
    }

    // Snapshots in last 24h
    const { count: snapshots24h } = await supabase
      .from('trader_snapshots')
      .select('id', { count: 'exact', head: true })
      .gte('captured_at', yesterday.toISOString())

    // Library items
    const { count: totalLibraryItems } = await supabase
      .from('library_items')
      .select('id', { count: 'exact', head: true })

    const { count: libraryWithPdf } = await supabase
      .from('library_items')
      .select('id', { count: 'exact', head: true })
      .not('pdf_url', 'is', null)

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
