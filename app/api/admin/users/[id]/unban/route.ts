/**
 * 解封用户 API
 * POST /api/admin/users/[id]/unban
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'

export const dynamic = 'force-dynamic'

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
