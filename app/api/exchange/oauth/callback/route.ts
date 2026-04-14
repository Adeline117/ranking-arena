import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createLogger } from '@/lib/utils/logger'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { env } from '@/lib/env'

const logger = createLogger('exchange-oauth-callback')

// OAuth Token 交换配置（根据 Binance 官方文档）
const TOKEN_CONFIG: Record<string, {
  clientId: string
  clientSecret: string
  tokenUrl: string
  redirectUri: string
  userInfoUrl?: string
}> = {
  binance: {
    clientId: process.env.BINANCE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.BINANCE_OAUTH_CLIENT_SECRET || '',
    tokenUrl: 'https://accounts.binance.com/oauth/token',
    redirectUri: `${env.NEXT_PUBLIC_APP_URL}/exchange/auth/callback`,
    userInfoUrl: 'https://www.binanceapis.com/oauth-api/v1/user-info',
  },
  bybit: {
    clientId: process.env.BYBIT_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.BYBIT_OAUTH_CLIENT_SECRET || '',
    tokenUrl: 'https://api.bybit.com/v5/account/oauth/token',
    redirectUri: `${env.NEXT_PUBLIC_APP_URL}/exchange/auth/callback`,
  },
}

/**
 * AES-256-CBC 加密
 */
function encrypt(text: string, key: string): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

/**
 * AES-256-CBC 解密
 */
function _decrypt(encryptedText: string, key: string): string {
  const [ivHex, encrypted] = encryptedText.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv)
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

/**
 * POST: 用授权码交换 Access Token
 */
export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    // Auth check - use authenticated user's ID
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // CSRF validation
    const csrfCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const csrfHeader = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(csrfCookie, csrfHeader)) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    const body = await request.json()
    const { exchange, code, state } = body
    const userId = user.id // Use authenticated user ID, not from body

    if (!exchange || !code || !state) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin() as SupabaseClient

    // 验证 state 并获取 code_verifier（如果使用 PKCE）
    const { data: stateData, error: stateError } = await supabase
      .from('oauth_states')
      .select('id, code_verifier')
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
    if (!config || !config.clientId) {
      return NextResponse.json({ error: `OAuth not configured for ${exchange}` }, { status: 400 })
    }

    // 构建 token 交换参数
    // Binance 使用 application/x-www-form-urlencoded 格式
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
    })

    // 根据是否使用 PKCE 选择认证方式
    if (stateData.code_verifier) {
      // PKCE 流程：使用 code_verifier
      tokenParams.append('code_verifier', stateData.code_verifier)
    } else {
      // 标准流程：使用 client_secret
      tokenParams.append('client_secret', config.clientSecret)
    }

    // 交换 code 获取 access_token
    const tokenResponse = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: tokenParams.toString(),
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      logger.error('Token exchange failed', { errorText, exchange })
      try {
        const errorJson = JSON.parse(errorText)
        return NextResponse.json({ 
          error: errorJson.error_description || errorJson.error || 'Failed to exchange token' 
        }, { status: 400 })
      } catch {
        return NextResponse.json({ error: 'Failed to exchange token' }, { status: 400 })
      }
    }

    const tokenData = await tokenResponse.json()
    const { access_token, refresh_token, expires_in } = tokenData

    if (!access_token) {
      return NextResponse.json({ error: 'No access token received' }, { status: 400 })
    }

    // 加密存储 tokens
    const encryptionKey = process.env.ENCRYPTION_KEY
    if (!encryptionKey) {
      logger.error('ENCRYPTION_KEY not configured')
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    const encryptedAccessToken = encrypt(access_token, encryptionKey)
    const encryptedRefreshToken = refresh_token ? encrypt(refresh_token, encryptionKey) : null

    // 计算过期时间
    const expiresAt = expires_in
      ? new Date(Date.now() + expires_in * 1000).toISOString()
      : null

    // 尝试获取用户信息
    let exchangeUserId: string | null = null
    if (config.userInfoUrl) {
      try {
        const userInfoResponse = await fetch(config.userInfoUrl, {
          headers: {
            'Authorization': `Bearer ${access_token}`,
          },
        })
        if (userInfoResponse.ok) {
          const userInfo = await userInfoResponse.json()
          // Binance 返回格式: { code: "000000", data: { userId: "...", email: "..." } }
          if (userInfo.data?.userId) {
            exchangeUserId = userInfo.data.userId
          }
        }
      } catch (e: unknown) {
        logger.warn('Failed to fetch user info', { error: e, exchange })
      }
    }

    // 存储到数据库
    const { error: dbError } = await supabase
      .from('user_exchange_connections')
      .upsert({
        user_id: userId,
        exchange,
        exchange_user_id: exchangeUserId,
        access_token_encrypted: encryptedAccessToken,
        refresh_token_encrypted: encryptedRefreshToken,
        expires_at: expiresAt,
        is_active: true,
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'success',
        // 对于 OAuth 连接，不需要 API key/secret
        api_key_encrypted: 'oauth',
        api_secret_encrypted: 'oauth',
      }, {
        onConflict: 'user_id,exchange',
      })

    if (dbError) {
      logger.error('Error saving connection', { error: dbError, userId, exchange })
      return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 })
    }

    return NextResponse.json({ 
      success: true,
      exchangeUserId,
    })
  } catch (error: unknown) {
    logger.error('Error handling OAuth callback', { error })
    const _errorMessage = error instanceof Error ? error.message : 'Failed to handle callback'
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
