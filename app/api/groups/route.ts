import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

/**
 * GET /api/groups
 * 获取小组列表，支持排序和分页
 *
 * Query params:
 * - sort_by: 'activity' | 'member_count' | 'created_at' (default: 'member_count')
 * - limit: number (default: 10, max: 50)
 * - offset: number (default: 0)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const sortBy = searchParams.get('sort_by') || 'member_count'
    const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 50)
    const offset = parseInt(searchParams.get('offset') || '0')

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Build query - use only known columns from the groups table
    let query = supabase
      .from('groups')
      .select(`
        id,
        name,
        name_en,
        description,
        avatar_url,
        member_count
      `)

    // Apply sorting - currently only member_count is supported
    // TODO: Add created_at/updated_at sorting when columns are confirmed
    query = query.order('member_count', { ascending: false, nullsFirst: false })

    // Apply pagination
    query = query.range(offset, offset + limit - 1)

    const { data: groups, error } = await query

    if (error) {
      logger.dbError('fetch-groups', error, {})
      return NextResponse.json(
        { success: false, error: 'Failed to fetch groups' },
        { status: 500 }
      )
    }

    // Check if there are more results
    const { count } = await supabase
      .from('groups')
      .select('*', { count: 'exact', head: true })

    return NextResponse.json({
      success: true,
      data: {
        groups: groups || [],
        pagination: {
          limit,
          offset,
          total: count || 0,
          has_more: (offset + limit) < (count || 0),
        },
      },
    })
  } catch (error: unknown) {
    logger.apiError('/api/groups', error, {})
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}
