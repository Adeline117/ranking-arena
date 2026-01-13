/**
 * 连接交易所API
 * POST /api/exchange/connect
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  validateEnum,
} from '@/lib/api'
import { validateExchangeCredentials, SUPPORTED_EXCHANGES, type Exchange } from '@/lib/exchange'
import { encrypt } from '@/lib/exchange/encryption'

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth(req)
    const adminSupabase = getSupabaseAdmin()
    const body = await req.json()

    // 验证输入
    const exchange = validateEnum(body.exchange, SUPPORTED_EXCHANGES, {
      required: true,
      fieldName: '交易所',
    })!
    const apiKey = validateString(body.apiKey, {
      required: true,
      minLength: 10,
      fieldName: 'API Key',
    })!
    const apiSecret = validateString(body.apiSecret, {
      required: true,
      minLength: 10,
      fieldName: 'API Secret',
    })!
    const passphrase = validateString(body.passphrase)

    // Bitget 需要 passphrase
    if (exchange === 'bitget' && !passphrase) {
      const error = new Error('Bitget 需要提供 passphrase')
      ;(error as any).statusCode = 400
      throw error
    }

    // 验证 API 凭证
    try {
      const isValid = await validateExchangeCredentials(exchange as Exchange, {
        apiKey,
        apiSecret,
        passphrase: passphrase ?? undefined,
      })
      
      if (!isValid) {
        const error = new Error('API Key 或 Secret 无效，请检查您的凭证')
        ;(error as any).statusCode = 400
        throw error
      }
    } catch (err: any) {
      if (err.statusCode) throw err
      console.error('[exchange/connect] 验证凭证失败:', err)
      const error = new Error(err.message || 'API 凭证验证失败')
      ;(error as any).statusCode = 400
      throw error
    }

    // 加密存储凭证
    const encryptedApiKey = encrypt(apiKey)
    const encryptedSecret = encrypt(apiSecret)
    const encryptedPassphrase = passphrase ? encrypt(passphrase) : null

    // 保存或更新连接
    const { data: existing } = await adminSupabase
      .from('user_exchange_connections')
      .select('id')
      .eq('user_id', user.id)
      .eq('exchange', exchange)
      .maybeSingle()

    const connectionData = {
      api_key_encrypted: encryptedApiKey,
      api_secret_encrypted: encryptedSecret,
      is_active: true,
      last_sync_status: 'pending',
      updated_at: new Date().toISOString(),
      ...(encryptedPassphrase ? { access_token_encrypted: encryptedPassphrase } : {}),
    }

    if (existing) {
      const { error: updateError } = await adminSupabase
        .from('user_exchange_connections')
        .update(connectionData)
        .eq('id', existing.id)

      if (updateError) {
        throw new Error('更新连接失败')
      }
    } else {
      const { error: insertError } = await adminSupabase
        .from('user_exchange_connections')
        .insert({
          user_id: user.id,
          exchange,
          ...connectionData,
        })

      if (insertError) {
        throw new Error('创建连接失败')
      }
    }

    return success({
      message: `已成功连接 ${exchange}，正在同步数据...`,
    })
  } catch (error) {
    return handleError(error, 'exchange/connect')
  }
}
