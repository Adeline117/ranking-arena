/**
 * 解封用户 API
 * POST /api/admin/users/[id]/unban
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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')
    
    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    const { id: userId } = await params
    
    // Check if user exists
    const { data: targetUser, error: userError } = await supabase
      .from('user_profiles')
      .select('id, handle, banned_at')
      .eq('id', userId)
      .maybeSingle()
    
    if (userError || !targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    
    // Check if user is banned
    if (!targetUser.banned_at) {
      return NextResponse.json({ error: 'User is not banned' }, { status: 400 })
    }
    
    // Unban the user
    const { error: unbanError } = await supabase
      .from('user_profiles')
      .update({
        banned_at: null,
        banned_reason: null,
        banned_by: null,
      })
      .eq('id', userId)
    
    if (unbanError) {
      console.error('Error unbanning user:', unbanError)
      return NextResponse.json({ error: unbanError.message }, { status: 500 })
    }
    
    // Log the action
    await supabase.from('admin_logs').insert({
      admin_id: admin.id,
      action: 'unban_user',
      target_type: 'user',
      target_id: userId,
      details: { handle: targetUser.handle },
    })
    
    return NextResponse.json({
      ok: true,
      message: 'User unbanned successfully',
    })
  } catch (error: any) {
    console.error('Unban user API error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
