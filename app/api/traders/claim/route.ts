/**
 * 交易员认领 API
 * GET /api/traders/claim - 获取用户的认领状态
 * POST /api/traders/claim - 提交认领申请
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  validateEnum,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import {
  getUserClaim,
  getUserVerifiedTrader,
  createClaim,
  isTraderClaimed,
  type VerificationMethod,
} from '@/lib/data/trader-claims'

/**
 * GET /api/traders/claim
 * 获取用户的认领状态
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const [claim, verified] = await Promise.all([
      getUserClaim(supabase, user.id),
      getUserVerifiedTrader(supabase, user.id),
    ])

    return success({
      claim,
      verified_trader: verified,
      is_verified: !!verified,
    })
  } catch (error: unknown) {
    return handleError(error, 'trader claim GET')
  }
}

/**
 * POST /api/traders/claim
 * 提交认领申请
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    const trader_id = validateString(body.trader_id, { required: true, fieldName: 'trader_id' })
    const source = validateString(body.source, { required: true, fieldName: 'source' })
    const verification_method = validateEnum(
      body.verification_method,
      ['api_key', 'signature', 'video', 'social'] as const
    )

    if (!trader_id || !source || !verification_method) {
      return handleError(new Error('缺少必填参数'), 'trader claim POST')
    }

    // 检查是否已被认领
    const isClaimed = await isTraderClaimed(supabase, trader_id, source)
    if (isClaimed) {
      return handleError(new Error('该交易员账号已被认领或正在审核中'), 'trader claim POST')
    }

    // 检查用户是否已有认领
    const existingVerified = await getUserVerifiedTrader(supabase, user.id)
    if (existingVerified) {
      return handleError(new Error('您已认证了一个交易员账号'), 'trader claim POST')
    }

    const claim = await createClaim(supabase, user.id, {
      trader_id,
      source,
      verification_method: verification_method as VerificationMethod,
      verification_data: body.verification_data,
    })

    return success({
      claim,
      message: '认领申请已提交，我们将尽快审核',
    })
  } catch (error: unknown) {
    return handleError(error, 'trader claim POST')
  }
}
