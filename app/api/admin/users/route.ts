/**
 * 用户管理 API
 * GET /api/admin/users - 获取用户列表（支持分页、搜索）
 */

import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { successWithPagination } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'
import { parsePage, parseLimit } from '@/lib/utils/safe-parse'

const logger = createLogger('admin-users')

export const dynamic = 'force-dynamic'

export const GET = withAdminAuth(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const page = parsePage(searchParams.get('page'))
    const limit = parseLimit(searchParams.get('limit'), 20, 200)
    const search = searchParams.get('search') || ''
    const filter = searchParams.get('filter') || 'all' // all, banned, active

    const offset = (page - 1) * limit

    // KEEP 'exact' — powers admin user-browser pagination ("Showing X-Y of Z
    // users"). user_profiles is relatively small and the admin needs to know
    // the correct total when paging through ban/search filters.
    let query = supabase
      .from('user_profiles')
      .select('id, handle, email, avatar_url, bio, follower_count, following_count, role, banned_at, banned_reason, banned_by, created_at, updated_at', { count: 'exact' })

    // Apply search filter — defense in depth.
    //
    // SECURITY (audit P1-7, 2026-04-09): the previous implementation
    // string-interpolated the user-supplied search term into a PostgREST
    // .or() filter DSL. The sanitization stripped backslash, %, _, ., , ()
    // — but `or()` parsing also recognizes commas as field separators and
    // colons as operator separators, so a search like `,role.eq.admin`
    // would historically have been a filter-injection vector. Sanitization
    // already kills the obvious chars, but constructing the filter from a
    // user string is a footgun.
    //
    // Stricter approach: aggressively strip the search term to a tight
    // alphanumeric+space+@+. allowlist (covering email and handle chars),
    // then restrict to a reasonable max length. Any remaining query is
    // safe to interpolate.
    if (search) {
      const sanitizedSearch = search
        .slice(0, 80)
        // Allowlist: a-z A-Z 0-9 dash underscore dot @ + space (handles + emails)
        .replace(/[^a-zA-Z0-9_\-.@\s]/g, '')
        .trim()
      if (sanitizedSearch.length > 0 && sanitizedSearch.length <= 80) {
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
      throw ApiError.database('Database operation failed')
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
