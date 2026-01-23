/**
 * 用户管理 API
 * GET /api/admin/users - 获取用户列表（支持分页、搜索）
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const logger = createLogger('admin-users')

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    // 速率限制检查（Admin 路由使用 sensitive 预设：15次/分钟）
    const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.sensitive)
    if (rateLimitResponse) {
      logger.warn('Rate limit exceeded for admin/users')
      return rateLimitResponse
    }

    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')

    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    const { searchParams } = new URL(req.url)
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '20')
    const search = searchParams.get('search') || ''
    const filter = searchParams.get('filter') || 'all' // all, banned, active
    
    const offset = (page - 1) * limit
    
    let query = supabase
      .from('user_profiles')
      .select('id, handle, email, avatar_url, bio, follower_count, following_count, role, banned_at, banned_reason, banned_by, created_at, updated_at', { count: 'exact' })
    
    // Apply search filter (sanitize to prevent PostgREST filter injection)
    if (search) {
      const sanitizedSearch = search
        .slice(0, 100)
        .replace(/[\\%_]/g, c => `\\${c}`)
        .replace(/[.,()]/g, '')
      if (sanitizedSearch) {
        query = query.or(`handle.ilike.%${sanitizedSearch}%,email.ilike.%${sanitizedSearch}%`)
      }
    }
    
    // Apply status filter
    if (filter === 'banned') {
      query = query.not('banned_at', 'is', null)
    } else if (filter === 'active') {
      query = query.is('banned_at', null)
    }
    
    // Apply pagination and ordering
    const { data: users, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    
    if (error) {
      logger.error('Error fetching users', { error, page, limit, search, filter })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({
      ok: true,
      users,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (error) {
    logger.error('Users API error', { error })
    const errorMessage = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
