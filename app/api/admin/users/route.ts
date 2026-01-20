/**
 * 用户管理 API
 * GET /api/admin/users - 获取用户列表（支持分页、搜索）
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
