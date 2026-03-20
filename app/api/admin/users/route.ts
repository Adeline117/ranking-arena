/**
 * 用户管理 API
 * GET /api/admin/users - 获取用户列表（支持分页、搜索）
 */

import { NextResponse } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success as apiSuccess, successWithPagination } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { parsePaginationParams } from '@/lib/api/pagination'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-users')

export const dynamic = 'force-dynamic'

export const GET = withAdminAuth(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10) || 20, 200)
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
      throw ApiError.database(error.message)
    }

    return successWithPagination(
      users || [],
      {
        limit,
        offset,
        has_more: (count || 0) > offset + limit,
        total: count || 0,
      }
    )
  },
  { name: 'admin-users' }
)
