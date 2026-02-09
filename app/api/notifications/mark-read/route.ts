/**
 * 标记通知已读 API
 * 
 * POST /api/notifications/mark-read
 * Body: { notification_ids?: string[], mark_all?: boolean }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

export async function POST(request: NextRequest) {
  try {
    // 验证认证
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未授权' }, { status: 401 })
    }

    const token = authHeader.split(' ')[1]
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: '服务器配置错误' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    
    // 验证用户
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: '认证失败' }, { status: 401 })
    }

    const body = await request.json()
    const { notification_ids, mark_all } = body

    if (mark_all) {
      // 标记所有为已读
      const { error } = await supabase
        .from('notifications')
        .update({ read: true, read_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .eq('read', false)

      if (error) {
        logger.error('[API] 标记全部已读失败:', error)
        return NextResponse.json({ error: '操作失败' }, { status: 500 })
      }

      return NextResponse.json({ 
        success: true, 
        message: '已标记全部为已读',
      })
    }

    if (!notification_ids || notification_ids.length === 0) {
      return NextResponse.json({ error: '缺少通知 ID' }, { status: 400 })
    }

    // 标记指定通知为已读
    const { error } = await supabase
      .from('notifications')
      .update({ read: true, read_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .in('id', notification_ids)

    if (error) {
      logger.error('[API] 标记已读失败:', error)
      return NextResponse.json({ error: '操作失败' }, { status: 500 })
    }

    return NextResponse.json({ 
      success: true, 
      message: `已标记 ${notification_ids.length} 条通知为已读`,
    })
  } catch (error: unknown) {
    logger.error('[API] 标记已读错误:', error)
    return NextResponse.json(
      { error: '服务器错误' },
      { status: 500 }
    )
  }
}
