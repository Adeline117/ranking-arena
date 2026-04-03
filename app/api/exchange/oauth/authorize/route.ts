import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createLogger } from '@/lib/utils/logger'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { env } from '@/lib/env'

const logger = createLogger('exchange-oauth-authorize')

// OAuth 配置（根据 Binance 官方文档）
const OAUTH_CONFIG: Record<string, {
  clientId: string
  redirectUri: string
  authUrl: string
  scope: string
  supportsPKCE?: boolean
}> = {
  binance: {
    clientId: process.env.BINANCE_OAUTH_CLIENT_ID || '',
    redirectUri: `${env.NEXT_PUBLIC_APP_URL}/exchange/auth/callback`,
    // Binance 授权 URL 需要带语言前缀
    authUrl: 'https://accounts.binance.com/en/oauth/authorize',
    // Binance scope 格式：逗号分隔
    scope: 'user:openId,user:email',
    supportsPKCE: true,
  },
  bybit: {
    clientId: process.env.BYBIT_OAUTH_CLIENT_ID || '',
    redirectUri: `${env.NEXT_PUBLIC_APP_URL}/exchange/auth/callback`,
    authUrl: 'https://api.bybit.com/v5/account/oauth/authorize',
    scope: 'read',
    supportsPKCE: false,
  },
}

/**
 * 生成 PKCE code_verifier（随机字符串）
 */
function generateCodeVerifier(): string {
  // 生成 28 个随机字节，转为十六进制字符串
  return crypto.randomBytes(28).toString('hex')
}

/**
 * 生成 PKCE code_challenge（code_verifier 的 SHA256 hash，Base64 URL 编码）
 */
function generateCodeChallenge(codeVerifier: string): string {
  const hash = crypto.createHash('sha256').update(codeVerifier).digest()
  // Base64 URL 编码：替换 + 为 -，/ 为 _，去掉末尾 =
  return hash.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export async function GET(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
    if (rateLimitResponse) return rateLimitResponse

    // Auth check - use authenticated user's ID instead of trusting query params
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const exchange = searchParams.get('exchange')
    const userId = user.id // Use authenticated user ID, not from query params
    // 是否使用 PKCE 流程（适用于浏览器/移动端应用）
    const usePKCE = searchParams.get('pkce') === 'true'

    if (!exchange) {
      return NextResponse.json({ error: 'Missing exchange' }, { status: 400 })
    }

    const config = OAUTH_CONFIG[exchange]
    if (!config || !config.clientId) {
      return NextResponse.json({ error: `OAuth not configured for ${exchange}` }, { status: 400 })
    }

    // 生成 state（用于防止 CSRF 攻击）
    const state = crypto.randomBytes(20).toString('hex')
    
    // PKCE 相关参数
    let codeVerifier: string | null = null
    let codeChallenge: string | null = null
    
    if (usePKCE && config.supportsPKCE) {
      codeVerifier = generateCodeVerifier()
      codeChallenge = generateCodeChallenge(codeVerifier)
    }

    // 存储 state 到数据库（关联 userId）
    const supabase = getSupabaseAdmin()
    const { error: insertError } = await supabase
      .from('oauth_states')
      .insert({
        user_id: userId,
        exchange,
        state,
        code_verifier: codeVerifier, // 存储 code_verifier 用于后续验证
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10分钟过期
      })

    if (insertError) {
      logger.error('Error storing OAuth state', { error: insertError, userId, exchange })
      return NextResponse.json({ error: 'Failed to initialize OAuth flow' }, { status: 500 })
    }

    // 构建授权 URL 参数
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scope,
      state,
    }

    // 如果使用 PKCE，添加 code_challenge
    if (codeChallenge) {
      params.code_challenge = codeChallenge
      params.code_challenge_method = 'S256'
    }

    const authUrl = `${config.authUrl}?${new URLSearchParams(params).toString()}`

    return NextResponse.json({ 
      authUrl, 
      state,
      usePKCE: !!codeChallenge,
    })
  } catch (error: unknown) {
    logger.error('Error generating OAuth URL', { error })
    const _errorMessage = error instanceof Error ? error.message : 'Failed to generate OAuth URL'
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
