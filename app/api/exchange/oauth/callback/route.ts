import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// OAuth Token 交换配置
const TOKEN_CONFIG: Record<string, {
  clientId: string
  clientSecret: string
  tokenUrl: string
  redirectUri: string
}> = {
  binance: {
    clientId: process.env.BINANCE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.BINANCE_OAUTH_CLIENT_SECRET || '',
    tokenUrl: 'https://accounts.binance.com/oauth/token',
    redirectUri: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/exchange/auth/callback?exchange=binance`,
  },
  bybit: {
    clientId: process.env.BYBIT_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.BYBIT_OAUTH_CLIENT_SECRET || '',
    tokenUrl: 'https://api.bybit.com/v5/account/oauth/token',
    redirectUri: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/exchange/auth/callback?exchange=bybit`,
  },
}

// 简单的加密函数（生产环境应使用更安全的方法）
function encrypt(text: string, key: string): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { exchange, code, state, userId } = body

    if (!exchange || !code || !state || !userId) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 })
    }

    // 验证 state
    const supabase = createClient(supabaseUrl, supabaseServiceKey)
    const { data: stateData, error: stateError } = await supabase
      .from('oauth_states')
      .select('*')
      .eq('user_id', userId)
      .eq('exchange', exchange)
      .eq('state', state)
      .gt('expires_at', new Date().toISOString())
      .single()

    if (stateError || !stateData) {
      return NextResponse.json({ error: 'Invalid or expired state' }, { status: 400 })
    }

    // 删除已使用的 state
    await supabase.from('oauth_states').delete().eq('id', stateData.id)

    // 获取 token 配置
    const config = TOKEN_CONFIG[exchange]
    if (!config || !config.clientId || !config.clientSecret) {
      return NextResponse.json({ error: `OAuth not configured for ${exchange}` }, { status: 400 })
    }

    // 交换 code 获取 access_token
    const tokenResponse = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    })

    if (!tokenResponse.ok) {
      const error = await tokenResponse.json()
      return NextResponse.json({ error: error.error_description || 'Failed to exchange token' }, { status: 400 })
    }

    const tokenData = await tokenResponse.json()
    const { access_token, refresh_token, expires_in } = tokenData

    // 加密存储 tokens
    const encryptionKey = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex')
    const encryptedAccessToken = encrypt(access_token, encryptionKey)
    const encryptedRefreshToken = refresh_token ? encrypt(refresh_token, encryptionKey) : null

    // 计算过期时间
    const expiresAt = expires_in
      ? new Date(Date.now() + expires_in * 1000).toISOString()
      : null

    // 存储到数据库
    const { error: dbError } = await supabase
      .from('user_exchange_connections')
      .upsert({
        user_id: userId,
        exchange,
        access_token_encrypted: encryptedAccessToken,
        refresh_token_encrypted: encryptedRefreshToken,
        expires_at: expiresAt,
        is_active: true,
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'success',
      }, {
        onConflict: 'user_id,exchange',
      })

    if (dbError) {
      console.error('Error saving connection:', dbError)
      return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Error handling OAuth callback:', error)
    return NextResponse.json({ error: error.message || 'Failed to handle callback' }, { status: 500 })
  }
}

