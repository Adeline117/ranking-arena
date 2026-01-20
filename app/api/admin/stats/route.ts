/**
 * 数据仪表盘统计 API
 * GET /api/admin/stats - 获取关键统计数据
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  
  if (!url || !key) {
    throw new Error('Supabase env missing')
  }
  
  return createClient(url, key, { auth: { persistSession: false } })
}

async function verifyAdmin(supabase: ReturnType<typeof getSupabaseAdmin>, authHeader: string | null) {
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }
  
  const token = authHeader.slice(7)
  const { data: { user }, error } = await supabase.auth.getUser(token)
  
  if (error || !user) {
    return null
  }
  
  // Check if user is admin
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  
  if (profile?.role !== 'admin') {
    return null
  }
  
  return user
}

export async function GET(req: Request) {
  try {
    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')
    
    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
    
    // User statistics
    const { count: totalUsers } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
    
    const { count: newUsersToday } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today.toISOString())
    
    const { count: newUsersYesterday } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', yesterday.toISOString())
      .lt('created_at', today.toISOString())
    
    const { count: bannedUsers } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .not('banned_at', 'is', null)
    
    // Post statistics
    const { count: totalPosts } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
    
    const { count: newPostsToday } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today.toISOString())
    
    const { count: newPostsYesterday } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', yesterday.toISOString())
      .lt('created_at', today.toISOString())
    
    // Comment statistics
    const { count: totalComments } = await supabase
      .from('comments')
      .select('*', { count: 'exact', head: true })
    
    const { count: newCommentsToday } = await supabase
      .from('comments')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today.toISOString())
    
    // Report statistics
    const { count: pendingReports } = await supabase
      .from('content_reports')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending')
    
    const { count: reportsThisWeek } = await supabase
      .from('content_reports')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', weekAgo.toISOString())
    
    // Group statistics
    const { count: totalGroups } = await supabase
      .from('groups')
      .select('*', { count: 'exact', head: true })
    
    const { count: pendingGroupApplications } = await supabase
      .from('group_applications')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending')
    
    // Scraper health summary (reuse existing logic)
    let scraperHealth = { fresh: 0, stale: 0, critical: 0 }
    try {
      const freshnessRes = await fetch(
        `${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/api/cron/check-data-freshness`
      )
      const freshnessData = await freshnessRes.json()
      if (freshnessData.summary) {
        scraperHealth = {
          fresh: freshnessData.summary.fresh || 0,
          stale: freshnessData.summary.stale || 0,
          critical: freshnessData.summary.critical || 0,
        }
      }
    } catch (e) {
      console.error('Error fetching scraper health:', e)
    }
    
    return NextResponse.json({
      ok: true,
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
      },
      generatedAt: now.toISOString(),
    })
  } catch (error: any) {
    console.error('Stats API error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
