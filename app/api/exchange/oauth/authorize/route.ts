import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// OAuth 配置（需要从环境变量获取）
const OAUTH_CONFIG: Record<string, {
  clientId: string
  redirectUri: string
  authUrl: string
  scope?: string
}> = {
  binance: {
    clientId: process.env.BINANCE_OAUTH_CLIENT_ID || '',
    redirectUri: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/exchange/auth/callback?exchange=binance`,
    authUrl: 'https://accounts.binance.com/oauth/authorize',
    scope: 'read',
  },
  bybit: {
    clientId: process.env.BYBIT_OAUTH_CLIENT_ID || '',
    redirectUri: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/exchange/auth/callback?exchange=bybit`,
    authUrl: 'https://api.bybit.com/v5/account/oauth/authorize',
    scope: 'read',
  },
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const exchange = searchParams.get('exchange')
    const userId = searchParams.get('userId')

    if (!exchange || !userId) {
      return NextResponse.json({ error: 'Missing exchange or userId' }, { status: 400 })
    }

    const config = OAUTH_CONFIG[exchange]
    if (!config || !config.clientId) {
      return NextResponse.json({ error: `OAuth not configured for ${exchange}` }, { status: 400 })
    }

    // 生成 state（用于防止 CSRF 攻击）
    const state = crypto.randomBytes(32).toString('hex')
    
    // 存储 state 到数据库（关联 userId）
    const supabase = createClient(supabaseUrl, supabaseServiceKey)
    await supabase
      .from('oauth_states')
      .insert({
        user_id: userId,
        exchange,
        state,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10分钟过期
      })

    // 构建授权 URL
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      state,
      ...(config.scope && { scope: config.scope }),
    })

    const authUrl = `${config.authUrl}?${params.toString()}`

    return NextResponse.json({ authUrl, state })
  } catch (error: any) {
    console.error('Error generating OAuth URL:', error)
    return NextResponse.json({ error: error.message || 'Failed to generate OAuth URL' }, { status: 500 })
  }
}

