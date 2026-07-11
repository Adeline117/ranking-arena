#!/usr/bin/env node
/**
 * Trust-scorecard daily snapshot (P6 可信度记分卡, 2026-07-10).
 *
 * The one metric too heavy for the panel RPC — serving-set series coverage
 * (12k serving traders × EXISTS over 12 monthly trader_series partitions,
 * measured 14s) — is computed here nightly and written into
 * arena.trust_scorecard_daily. arena_trust_scorecard() serves it instantly.
 *
 * Cron: crontab 07:40 daily (after schema-canary 07:30), Mac Mini.
 * Usage: node scripts/qa/trust-scorecard-snapshot.mjs
 */
import { config } from 'dotenv'
import { resolve } from 'path'
import pg from 'pg'

config({ path: resolve(process.cwd(), '.env.local') })

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
if (!dbUrl) {
  console.error('SUPABASE_DB_URL / DATABASE_URL missing')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: dbUrl, max: 1 })

// 接地陷阱(2026-07-10 实测):12 个 serving 源(mexc/gateio/bybit/binance_web3…
// 共 7158 交易员)的 lr.source 是 legacy 名,只能经 sources.meta->>'legacy_platform'
// 映射;直接 slug 直连会把它们整段漏掉,覆盖率虚高(71% vs 真 ~54%)。
const COVERAGE_SQL = `
WITH srcmap AS (
  SELECT slug AS key, id FROM arena.sources
  UNION
  SELECT meta->>'legacy_platform', id FROM arena.sources WHERE meta ? 'legacy_platform'
), serving AS (
  SELECT lr.source, lr.source_trader_id,
         bool_or(lr.season_id = '90D' AND lr.rank <= 500) AS is_top500
    FROM public.leaderboard_ranks lr
   GROUP BY 1, 2
), joined AS (
  SELECT sv.is_top500,
         EXISTS (SELECT 1 FROM arena.trader_series ts WHERE ts.trader_id = t.id) AS has_series
    FROM serving sv
    JOIN srcmap sm ON sm.key = sv.source
    JOIN arena.traders t ON t.source_id = sm.id AND t.exchange_trader_id = sv.source_trader_id
)
SELECT count(*)::int                                          AS serving_total,
       count(*) FILTER (WHERE has_series)::int                AS with_series,
       count(*) FILTER (WHERE is_top500)::int                 AS top500_total,
       count(*) FILTER (WHERE is_top500 AND has_series)::int  AS top500_with_series
  FROM joined`

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[telegram skipped]', text)
    return
  }
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  }).catch((e) => console.error('telegram send failed:', e.message))
}

async function main() {
  // --daily-guard(CI 用):今天已有 <20h 内写入的快照即秒退——挂在每 30min
  // 的 pipeline-health job 上实现「每日至多一次」,不再赌 GH 单一 schedule
  // 时刻(2026-07-11 实证:新加的 '45 6' schedule 事件整天没触发,job 恒 skipped)。
  if (process.argv.includes('--daily-guard')) {
    const { rows: guard } = await pool.query(
      `SELECT 1 FROM arena.trust_scorecard_daily
        WHERE taken_on = current_date AND created_at > now() - interval '20 hours'`
    )
    if (guard.length > 0) {
      console.log('[trust-scorecard] today already snapshotted — guard exit')
      await pool.end()
      return
    }
  }
  const t0 = Date.now()
  const { rows } = await pool.query(COVERAGE_SQL)
  const payload = rows[0]
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  // 回归断言:对比昨快照,覆盖净倒退即 Telegram 告警(轮换侵蚀/管道停摆
  // 不再等人看面板)。首日无基线自然跳过。
  const { rows: prevRows } = await pool.query(
    `SELECT payload FROM arena.trust_scorecard_daily
      WHERE taken_on < current_date ORDER BY taken_on DESC LIMIT 1`
  )
  const prev = prevRows[0]?.payload
  await pool.query(
    `INSERT INTO arena.trust_scorecard_daily (taken_on, payload)
     VALUES (current_date, $1::jsonb)
     ON CONFLICT (taken_on) DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
    [JSON.stringify(payload)]
  )
  const pct = ((payload.with_series / payload.serving_total) * 100).toFixed(1)
  const pct500 = ((payload.top500_with_series / payload.top500_total) * 100).toFixed(1)
  console.log(
    `[trust-scorecard] ${new Date().toISOString()} coverage=${pct}% (${payload.with_series}/${payload.serving_total}) top500=${pct500}% (${payload.top500_with_series}/${payload.top500_total}) in ${secs}s`
  )
  if (prev) {
    const dAll = payload.with_series - prev.with_series
    const d500 = payload.top500_with_series - prev.top500_with_series
    console.log(
      `[trust-scorecard] day-delta all=${dAll >= 0 ? '+' : ''}${dAll} top500=${d500 >= 0 ? '+' : ''}${d500}`
    )
    if (dAll < 0 || d500 < -3) {
      await sendTelegram(
        `⚠️ 可信度记分卡回归: 序列覆盖日增 all=${dAll} top500=${d500} ` +
          `(现 ${pct}%/${pct500}%)。查 series-backfill 游标与板面轮换。`
      )
    }
  }
  await pool.end()
}

main().catch((e) => {
  console.error('[trust-scorecard] FAILED:', e.message)
  process.exit(1)
})
