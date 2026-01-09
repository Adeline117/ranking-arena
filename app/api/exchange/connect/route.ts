/**
 * 连接交易所API
 * POST /api/exchange/connect
 * 
 * 请求体：
 * {
 *   exchange: 'binance',
 *   apiKey: 'xxx',
 *   apiSecret: 'xxx'
 * }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validateBinanceCredentials } from '@/lib/exchange/binance'
import { encrypt } from '@/lib/exchange/encryption'

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

export async function POST(req: NextRequest) {
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
    const { exchange, apiKey, apiSecret } = body

    if (!exchange || !apiKey || !apiSecret) {
      return NextResponse.json(
        { error: '缺少必要参数：exchange, apiKey, apiSecret' },
        { status: 400 }
      )
    }

    // 3. 验证API凭证（仅支持Binance）
    if (exchange === 'binance') {
      const isValid = await validateBinanceCredentials({ apiKey, apiSecret })
      if (!isValid) {
        return NextResponse.json(
          { error: 'API Key或Secret无效，请检查您的凭证' },
          { status: 400 }
        )
      }
    } else {
      return NextResponse.json(
        { error: `暂不支持交易所: ${exchange}` },
        { status: 400 }
      )
    }

    // 4. 加密存储凭证
    const encryptedApiKey = encrypt(apiKey)
    const encryptedSecret = encrypt(apiSecret)

    // 5. 保存或更新连接
    const { data: existing } = await adminSupabase
      .from('user_exchange_connections')
      .select('id')
      .eq('user_id', user.id)
      .eq('exchange', exchange)
      .maybeSingle()

    if (existing) {
      // 更新现有连接
      const { error: updateError } = await adminSupabase
        .from('user_exchange_connections')
        .update({
          api_key_encrypted: encryptedApiKey,
          api_secret_encrypted: encryptedSecret,
          is_active: true,
          last_sync_status: 'pending',
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)

      if (updateError) {
        console.error('[exchange/connect] 更新连接失败:', updateError)
        return NextResponse.json(
          { error: '更新连接失败' },
          { status: 500 }
        )
      }
    } else {
      // 创建新连接
      const { error: insertError } = await adminSupabase
        .from('user_exchange_connections')
        .insert({
          user_id: user.id,
          exchange,
          api_key_encrypted: encryptedApiKey,
          api_secret_encrypted: encryptedSecret,
          is_active: true,
          last_sync_status: 'pending',
        })

      if (insertError) {
        console.error('[exchange/connect] 创建连接失败:', insertError)
        return NextResponse.json(
          { error: '创建连接失败' },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({
      success: true,
      message: '连接成功，正在同步数据...',
    })
  } catch (error: any) {
    console.error('[exchange/connect] 错误:', error)
    return NextResponse.json(
      { error: error.message || '连接失败' },
      { status: 500 }
    )
  }
}

