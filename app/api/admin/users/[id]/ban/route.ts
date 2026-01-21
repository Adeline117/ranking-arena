/**
 * 封禁用户 API
 * POST /api/admin/users/[id]/ban
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-ban-user')

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
    const body = await req.json()
    const { reason } = body
    
    // Check if user exists
    const { data: targetUser, error: userError } = await supabase
      .from('user_profiles')
      .select('id, handle, banned_at')
      .eq('id', userId)
      .maybeSingle()
    
    if (userError || !targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    
    // Check if already banned
    if (targetUser.banned_at) {
      return NextResponse.json({ error: 'User is already banned' }, { status: 400 })
    }
    
    // Prevent banning self
    if (userId === admin.id) {
      return NextResponse.json({ error: 'Cannot ban yourself' }, { status: 400 })
    }
    
    // Ban the user
    const { error: banError } = await supabase
      .from('user_profiles')
      .update({
        banned_at: new Date().toISOString(),
        banned_reason: reason || null,
        banned_by: admin.id,
      })
      .eq('id', userId)
    
    if (banError) {
      logger.error('Error banning user', { error: banError, userId, adminId: admin.id })
      return NextResponse.json({ error: banError.message }, { status: 500 })
    }
    
    // Log the action
    await supabase.from('admin_logs').insert({
      admin_id: admin.id,
      action: 'ban_user',
      target_type: 'user',
      target_id: userId,
      details: { reason, handle: targetUser.handle },
    })
    
    logger.info('User banned', { userId, adminId: admin.id, reason })
    
    return NextResponse.json({
      ok: true,
      message: 'User banned successfully',
    })
  } catch (error) {
    logger.error('Ban user API error', { error })
    const errorMessage = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
