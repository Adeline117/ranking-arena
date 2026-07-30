/**
 * 同步交易所数据 API
 * POST /api/exchange/sync
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api/response'
import { validateEnum } from '@/lib/api/validation'
import {
  exchangeApiSyncClaimResultSchema,
  exchangeApiSyncFinishResultSchema,
} from '@/lib/exchange/api-key-lifecycle'
import { decrypt } from '@/lib/exchange/encryption'
import { type Exchange, SUPPORTED_EXCHANGES } from '@/lib/exchange'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

// 导入各交易所客户端
import {
  getBinanceAccount,
  getBinanceTrades,
  calculateTradingStats as calculateBinanceTradingStats,
} from '@/lib/exchange/binance'
import { getBybitAccount, getBybitTrades, calculateBybitTradingStats } from '@/lib/exchange/bybit'
import {
  getBitgetAccount,
  getBitgetTrades,
  calculateBitgetTradingStats,
} from '@/lib/exchange/bitget'
import { getMexcAccount, getMexcTrades, calculateMexcTradingStats } from '@/lib/exchange/mexc'
import {
  getCoinexAccount,
  getCoinexTrades,
  calculateCoinexTradingStats,
} from '@/lib/exchange/coinex'

const logger = createLogger('exchange-sync')

export const POST = withAuth(
  async ({ user, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const exchange = validateEnum(body.exchange, SUPPORTED_EXCHANGES, {
      required: true,
      fieldName: 'exchange',
    })!

    // Claim the exact credential generation under the account lifecycle lock.
    // The exchange call itself is necessarily outside the transaction; its
    // outcome is accepted below only if this generation remains current.
    const adminSupabase = getSupabaseAdmin()
    const { data: claimResult, error: connError } = await adminSupabase.rpc(
      'claim_exchange_api_sync_atomic',
      {
        p_user_id: user.id,
        p_exchange: exchange,
      }
    )

    if (connError) {
      logger.error('Atomic exchange sync claim failed', {
        code: connError.code,
        exchange,
        userId: user.id,
      })
      return serverError('Unable to start exchange sync')
    }

    const parsedClaim = exchangeApiSyncClaimResultSchema.safeParse(claimResult)
    if (!parsedClaim.success) {
      logger.error('Atomic exchange sync claim returned an invalid acknowledgement', {
        exchange,
        userId: user.id,
      })
      return serverError('Unable to start exchange sync')
    }
    if (parsedClaim.data.status === 'suspended' || parsedClaim.data.status === 'missing_account') {
      return forbidden('Account unavailable')
    }
    if (parsedClaim.data.status !== 'claimed') {
      return notFound('No active exchange connection found')
    }
    if (parsedClaim.data.user_id !== user.id || parsedClaim.data.exchange !== exchange) {
      logger.error('Atomic exchange sync claim mismatched its actor', {
        exchange,
        userId: user.id,
      })
      return serverError('Unable to start exchange sync')
    }
    const connection = parsedClaim.data

    const finishSync = async (succeeded: boolean, errorMessage: string | null) => {
      const { data: finishResult, error: finishError } = await adminSupabase.rpc(
        'finish_exchange_api_sync_atomic',
        {
          p_user_id: user.id,
          p_connection_id: connection.connection_id,
          p_generation: connection.generation,
          p_succeeded: succeeded,
          p_error: errorMessage,
        }
      )

      if (finishError) {
        logger.error('Atomic exchange sync finish failed', {
          code: finishError.code,
          exchange,
          userId: user.id,
        })
        return false
      }

      const parsedFinish = exchangeApiSyncFinishResultSchema.safeParse(finishResult)
      if (
        !parsedFinish.success ||
        parsedFinish.data.status !== 'recorded' ||
        parsedFinish.data.user_id !== user.id ||
        parsedFinish.data.connection_id !== connection.connection_id ||
        parsedFinish.data.generation !== connection.generation ||
        parsedFinish.data.sync_status !== (succeeded ? 'success' : 'error')
      ) {
        logger.warn('Exchange sync outcome was rejected as stale', {
          exchange,
          userId: user.id,
          status: parsedFinish.success ? parsedFinish.data.status : 'invalid_ack',
        })
        return false
      }

      return true
    }

    // 解密凭证
    let apiKey: string
    let apiSecret: string
    let passphrase: string | undefined
    interface TradingStats {
      totalTrades: number
      avgProfit: number
      avgLoss: number
      profitableTradesPct: number
      tradesPerWeek: number
      activeSince?: Date | null
    }
    let stats: TradingStats | null = null

    try {
      apiKey = decrypt(connection.api_key_encrypted)
      apiSecret = decrypt(connection.api_secret_encrypted)
      // Passphrase (Bitget/OKX API-key auth) is written to passphrase_encrypted by
      // connect + verify-ownership. Reading it from access_token_encrypted (an
      // OAuth-only column, null for API-key exchanges) meant Bitget sync never had
      // a passphrase and always failed. Prefer the correct column; fall back to the
      // legacy access_token_encrypted only for any old mis-written rows.
      const passphraseCipher =
        connection.passphrase_encrypted ||
        (exchange === 'bitget' ? connection.legacy_access_token_encrypted : null)
      if (passphraseCipher) {
        passphrase = decrypt(passphraseCipher)
      }
      // 根据交易所类型获取数据
      switch (exchange as Exchange) {
        case 'binance': {
          await getBinanceAccount({ apiKey, apiSecret })
          const binanceTrades = await getBinanceTrades({ apiKey, apiSecret })
          stats = calculateBinanceTradingStats(binanceTrades)
          break
        }

        case 'bybit': {
          await getBybitAccount({ apiKey, apiSecret })
          const bybitTrades = await getBybitTrades({ apiKey, apiSecret })
          stats = calculateBybitTradingStats(bybitTrades)
          break
        }

        case 'bitget': {
          await getBitgetAccount({ apiKey, apiSecret, passphrase })
          const bitgetTrades = await getBitgetTrades({ apiKey, apiSecret, passphrase })
          stats = calculateBitgetTradingStats(bitgetTrades)
          break
        }

        case 'mexc': {
          await getMexcAccount({ apiKey, apiSecret })
          const mexcTrades = await getMexcTrades({ apiKey, apiSecret }, 'BTCUSDT')
          stats = calculateMexcTradingStats(mexcTrades)
          break
        }

        case 'coinex': {
          await getCoinexAccount({ apiKey, apiSecret })
          const coinexTrades = await getCoinexTrades({ apiKey, apiSecret }, 'BTCUSDT')
          stats = calculateCoinexTradingStats(coinexTrades)
          break
        }

        default:
          throw new Error(`Live sync is not implemented for ${exchange}`)
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Sync failed'
      logger.error(`${exchange} sync failed`, { error: errorMessage })
      const recorded = await finishSync(false, (errorMessage.trim() || 'Sync failed').slice(0, 500))
      if (!recorded) {
        throw new Error('Exchange sync result is no longer current')
      }
      throw err
    }

    // Note: stats persistence removed — the user_trading_data table was
    // intentionally dropped from prod and nothing ever read it. Stats are
    // still computed live and returned in the response below.

    if (!(await finishSync(true, null))) {
      return serverError('Exchange connection changed while sync was running')
    }

    return NextResponse.json({
      success: true,
      data: {
        message: 'Sync successful',
        tradesCount: stats?.totalTrades ?? 0,
        stats,
      },
    })
  },
  {
    name: 'exchange-sync',
    rateLimit: 'sensitive',
  }
)
