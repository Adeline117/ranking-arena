/**
 * 断开交易所连接API
 * DELETE /api/exchange/disconnect
 * 
 * 请求体：
 * {
 *   exchange: 'binance'
 * }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

export async function DELETE(req: NextRequest) {
  try {
    // 1. 获取用户身份
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: '未授权' }, { status: 401 })
    }

    // 从token中提取用户ID
    const token = authHeader.replace('Bearer ', '')
    const adminSupabase = getSupabaseAdmin()
    
    // 验证token并获取用户
    const { data: { user }, error: userError } = await adminSupabase.auth.getUser(token)
    if (userError || !user) {
      return NextResponse.json({ error: '未授权' }, { status: 401 })
    }

    // 2. 解析请求体
    const body = await req.json()
    const { exchange } = body

    if (!exchange) {
      return NextResponse.json(
        { error: '缺少必要参数：exchange' },
        { status: 400 }
      )
    }

    // 3. 删除连接（软删除：设置为非活跃）
    const adminSupabase = getSupabaseAdmin()
    const { error: updateError } = await adminSupabase
      .from('user_exchange_connections')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id)
      .eq('exchange', exchange)

    if (updateError) {
      console.error('[exchange/disconnect] 断开连接失败:', updateError)
      return NextResponse.json(
        { error: '断开连接失败' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      message: '已断开连接',
    })
  } catch (error: any) {
    console.error('[exchange/disconnect] 错误:', error)
    return NextResponse.json(
      { error: error.message || '断开连接失败' },
      { status: 500 }
    )
  }
}

