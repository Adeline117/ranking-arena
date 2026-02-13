/**
 * 数据新鲜度检查 Cron 端点
 *
 * GET /api/cron/check-data-freshness - 检查各平台数据是否过期
 *
 * 检查逻辑:
 * - 查询各平台最后一次成功抓取的时间
 * - 超过 8 小时 → stale，超过 24 小时 → critical
 * - 将告警记录到 Sentry 并发送通知
 * - 返回各平台的数据状态报告
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorized, getSupabaseEnv, getSupportedPlatforms } from '@/lib/cron/utils'
import { sendScraperAlert } from '@/lib/alerts/send-alert'
import { captureMessage } from '@/lib/utils/logger'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// 数据过期阈值（毫秒）
const STALE_THRESHOLD_MS = 8 * 60 * 60 * 1000 // 8 小时
const CRITICAL_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 小时

// 平台显示名称映射
const PLATFORM_NAMES: Record<string, string> = {
  binance_futures: 'Binance 合约',
  binance_spot: 'Binance 现货',
  binance_web3: 'Binance Web3',
  bybit: 'Bybit',
  bitget_futures: 'Bitget 合约',
  bitget_spot: 'Bitget 现货',
  mexc: 'MEXC',
  coinex: 'CoinEx',
  okx_web3: 'OKX Web3',
  okx_futures: 'OKX 合约',
  kucoin: 'KuCoin',
  gmx: 'GMX',
  htx: 'HTX',
  weex: 'WEEX',
  phemex: 'Phemex',
  bingx: 'BingX',
  gateio: 'Gate.io',
  xt: 'XT',
  gains: 'Gains Network',
  lbank: 'LBank',
  blofin: 'BloFin',
}

export interface PlatformFreshnessStatus {
  platform: string
  displayName: string
  lastUpdate: string | null
  ageMs: number | null
  ageHours: number | null
  status: 'fresh' | 'stale' | 'critical' | 'unknown'
  recordCount: number
}

export interface FreshnessReport {
  ok: boolean
  checked_at: string
  summary: {
    total: number
    fresh: number
    stale: number
    critical: number
    unknown: number
  }
  thresholds: {
    stale_hours: number
    critical_hours: number
  }
  platforms: PlatformFreshnessStatus[]
}

/**
 * 构建新鲜度报告（共享逻辑，cron 和 admin endpoint 都用）
 */
export async function buildFreshnessReport(): Promise<FreshnessReport> {
  const { url, serviceKey } = getSupabaseEnv()
  if (!url || !serviceKey) {
    throw new Error('Supabase 环境变量缺失')
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  })

  const platforms = getSupportedPlatforms()
  const results: PlatformFreshnessStatus[] = []
  const stalePlatforms: string[] = []
  const criticalPlatforms: string[] = []
  const now = Date.now()

  // 检查每个平台的数据新鲜度
  for (const platform of platforms) {
    try {
      // 查询该平台最新的快照记录
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', platform)
        .order('captured_at', { ascending: false })
        .limit(1)
        .single()

      if (error && error.code !== 'PGRST116') {
        logger.dbError('query-platform-freshness', error, { platform })
      }

      // 获取记录数量
      const { count } = await supabase
        .from('trader_snapshots')
        .select('id', { count: 'exact', head: true })
        .eq('source', platform)

      const lastUpdate = data?.captured_at || null
      let ageMs: number | null = null
      let ageHours: number | null = null
      let status: 'fresh' | 'stale' | 'critical' | 'unknown' = 'unknown'

      if (lastUpdate) {
        ageMs = now - new Date(lastUpdate).getTime()
        ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10

        if (ageMs >= CRITICAL_THRESHOLD_MS) {
          status = 'critical'
          criticalPlatforms.push(platform)
        } else if (ageMs >= STALE_THRESHOLD_MS) {
          status = 'stale'
          stalePlatforms.push(platform)
        } else {
          status = 'fresh'
        }
      }

      results.push({
        platform,
        displayName: PLATFORM_NAMES[platform] || platform,
        lastUpdate,
        ageMs,
        ageHours,
        status,
        recordCount: count || 0,
      })
    } catch (error: unknown) {
      logger.error('Error processing platform freshness', { platform }, error instanceof Error ? error : new Error(String(error)))
      results.push({
        platform,
        displayName: PLATFORM_NAMES[platform] || platform,
        lastUpdate: null,
        ageMs: null,
        ageHours: null,
        status: 'unknown',
        recordCount: 0,
      })
    }
  }

  const freshCount = results.filter((r) => r.status === 'fresh').length
  const unknownCount = results.filter((r) => r.status === 'unknown').length

  return {
    ok: criticalPlatforms.length === 0 && stalePlatforms.length === 0,
    checked_at: new Date().toISOString(),
    summary: {
      total: platforms.length,
      fresh: freshCount,
      stale: stalePlatforms.length,
      critical: criticalPlatforms.length,
      unknown: unknownCount,
    },
    thresholds: {
      stale_hours: STALE_THRESHOLD_MS / (1000 * 60 * 60),
      critical_hours: CRITICAL_THRESHOLD_MS / (1000 * 60 * 60),
    },
    platforms: results,
  }
}

/**
 * GET - 检查各平台数据新鲜度（cron 触发）
 */
export async function GET(req: Request) {
  // 验证授权
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const report = await buildFreshnessReport()

    const stalePlatforms = report.platforms.filter((p) => p.status === 'stale')
    const criticalPlatforms = report.platforms.filter((p) => p.status === 'critical')

    // ── Sentry 告警 ──────────────────────────────────────────
    if (criticalPlatforms.length > 0) {
      const names = criticalPlatforms.map((p) => p.displayName).join(', ')
      await captureMessage(
        `[DataFreshness] CRITICAL: ${names} 超过 24 小时未更新`,
        'error',
        {
          level: 'critical',
          stalePlatforms: stalePlatforms.map((p) => p.platform),
          criticalPlatforms: criticalPlatforms.map((p) => p.platform),
          summary: report.summary,
        }
      )
      logger.error(`Data severely stale: ${names} - not updated in 24h`, {
        criticalPlatforms: criticalPlatforms.map((p) => p.platform)
      }, new Error('Data severely stale'))
    } else if (stalePlatforms.length > 0) {
      const names = stalePlatforms.map((p) => p.displayName).join(', ')
      await captureMessage(
        `[DataFreshness] STALE: ${names} 超过 8 小时未更新`,
        'warning',
        {
          level: 'stale',
          stalePlatforms: stalePlatforms.map((p) => p.platform),
          summary: report.summary,
        }
      )
      logger.warn(`Data stale: ${names} - not updated in 8h`, {
        stalePlatforms: stalePlatforms.map((p) => p.platform)
      })
    }

    // ── Telegram 告警 ─────────────────────────────────────
    if (criticalPlatforms.length > 0 || stalePlatforms.length > 0) {
      const tgToken = process.env.TELEGRAM_BOT_TOKEN
      const tgChatId = process.env.TELEGRAM_ALERT_CHAT_ID

      if (tgToken && tgChatId) {
        try {
          const emoji = criticalPlatforms.length > 0 ? '🚨' : '⚠️'
          const lines: string[] = [
            `${emoji} <b>数据新鲜度告警</b>`,
            '',
          ]
          if (criticalPlatforms.length > 0) {
            lines.push(`<b>严重过期 (&gt;24h):</b>`)
            criticalPlatforms.forEach((p) => {
              lines.push(`  • ${p.displayName} — ${p.ageHours}h ago, ${p.recordCount} records`)
            })
          }
          if (stalePlatforms.length > 0) {
            lines.push(`<b>陈旧 (&gt;8h):</b>`)
            stalePlatforms.forEach((p) => {
              lines.push(`  • ${p.displayName} — ${p.ageHours}h ago, ${p.recordCount} records`)
            })
          }
          lines.push('', `✅ ${report.summary.fresh} fresh / ${report.summary.total} total`)

          const tgRes = await fetch(
            `https://api.telegram.org/bot${tgToken}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: tgChatId,
                text: lines.join('\n'),
                parse_mode: 'HTML',
              }),
            }
          )
          if (!tgRes.ok) {
            logger.error(`[DataFreshness] Telegram send failed: ${tgRes.status} ${await tgRes.text()}`)
          }
        } catch (tgErr) {
          logger.error('[DataFreshness] Telegram send error:', tgErr)
        }
      } else {
        logger.error('[DataFreshness] TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID not set. Alert details:', JSON.stringify({
          critical: criticalPlatforms.map(p => ({ platform: p.platform, ageHours: p.ageHours })),
          stale: stalePlatforms.map(p => ({ platform: p.platform, ageHours: p.ageHours })),
        }))
      }
    }

    // ── 外部告警通知（Slack / 飞书等）────────────────────────
    if (criticalPlatforms.length > 0 || stalePlatforms.length > 0) {
      try {
        const alertResult = await sendScraperAlert(
          criticalPlatforms.map((p) => p.platform),
          stalePlatforms.map((p) => p.platform),
          PLATFORM_NAMES
        )
        if (alertResult.sent) {
          // Alert sent successfully
        }
      } catch (error: unknown) {
        logger.error('Failed to send freshness alert', {}, error instanceof Error ? error : new Error(String(error)))
      }
    }

    return NextResponse.json(report)
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
