/**
 * 用户管理 API
 * GET /api/admin/users - 获取用户列表（支持分页、搜索）
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
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
    
    // Apply search filter
    if (search) {
      query = query.or(`handle.ilike.%${search}%,email.ilike.%${search}%`)
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
      console.error('Error fetching users:', error)
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
  } catch (error: any) {
    console.error('Users API error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
