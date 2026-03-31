import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

// Token 刷新配置
const REFRESH_CONFIG: Record<string, {
  clientId: string
  clientSecret: string
  tokenUrl: string
}> = {
  binance: {
    clientId: process.env.BINANCE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.BINANCE_OAUTH_CLIENT_SECRET || '',
    tokenUrl: 'https://accounts.binance.com/oauth/token',
  },
  bybit: {
    clientId: process.env.BYBIT_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.BYBIT_OAUTH_CLIENT_SECRET || '',
    tokenUrl: 'https://api.bybit.com/v5/account/oauth/token',
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
function decrypt(encryptedText: string, key: string): string {
  const [ivHex, encrypted] = encryptedText.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv)
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

/**
 * POST: 刷新 Access Token
 * 
 * 根据 Binance 官方文档：
 * POST https://accounts.binance.com/oauth/token
 * 参数：grant_type=refresh_token&refresh_token=xxx&client_id=xxx&client_secret=xxx
 */
export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    // Auth check - use authenticated user's ID instead of trusting request body
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
    const { exchange } = body
    const userId = user.id // Use authenticated user ID, not from body

    if (!exchange) {
      return NextResponse.json({ error: 'Missing exchange' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // 获取用户的交易所连接
    const { data: connection, error: connError } = await supabase
      .from('user_exchange_connections')
      .select('id, refresh_token_encrypted')
      .eq('user_id', userId)
      .eq('exchange', exchange)
      .single()

    if (connError || !connection) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
    }

    if (!connection.refresh_token_encrypted) {
      return NextResponse.json({ error: 'No refresh token available' }, { status: 400 })
    }

    // 解密 refresh_token
    const encryptionKey = process.env.ENCRYPTION_KEY
    if (!encryptionKey) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    const refreshToken = decrypt(connection.refresh_token_encrypted, encryptionKey)

    // 获取配置
    const config = REFRESH_CONFIG[exchange]
    if (!config || !config.clientId || !config.clientSecret) {
      return NextResponse.json({ error: `Refresh not configured for ${exchange}` }, { status: 400 })
    }

    // 根据 Binance 文档，使用 URL 参数格式
    const refreshParams = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    })

    const tokenResponse = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: refreshParams.toString(),
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      logger.error('Token refresh failed:', errorText)
      
      // 如果刷新失败，标记连接为不活跃
      await supabase
        .from('user_exchange_connections')
        .update({
          is_active: false,
          last_sync_status: 'error',
          last_sync_error: 'Token refresh failed',
        })
        .eq('id', connection.id)

      return NextResponse.json({ error: 'Token refresh failed, please re-authenticate' }, { status: 401 })
    }

    const tokenData = await tokenResponse.json()
    const { access_token, refresh_token: newRefreshToken, expires_in } = tokenData

    if (!access_token) {
      return NextResponse.json({ error: 'No access token received' }, { status: 400 })
    }

    // 加密新的 tokens
    const encryptedAccessToken = encrypt(access_token, encryptionKey)
    const encryptedRefreshToken = newRefreshToken 
      ? encrypt(newRefreshToken, encryptionKey) 
      : connection.refresh_token_encrypted

    // 计算新的过期时间
    const expiresAt = expires_in
      ? new Date(Date.now() + expires_in * 1000).toISOString()
      : null

    // 更新数据库
    const { error: updateError } = await supabase
      .from('user_exchange_connections')
      .update({
        access_token_encrypted: encryptedAccessToken,
        refresh_token_encrypted: encryptedRefreshToken,
        expires_at: expiresAt,
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'success',
        last_sync_error: null,
      })
      .eq('id', connection.id)

    if (updateError) {
      logger.error('Error updating connection:', updateError)
      return NextResponse.json({ error: 'Failed to save new tokens' }, { status: 500 })
    }

    return NextResponse.json({ 
      success: true,
      expiresAt,
    })
  } catch (error: unknown) {
    logger.error('Error refreshing token:', error)
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}


