#!/usr/bin/env node
/**
 * DB-size sentinel (上线运营审计 2026-07-11) — 容量红线监控此前为零。
 *
 * Supabase 库随月分区表只增不删(2026-07-11 实测 51GB,memory 里 24GB 已过时)。
 * 撞盘配额那天 = 写入连环失败(ingest/发帖/订阅全 500),第一个发现的是用户。
 * 这里每日报 pg_database_size + top 表,超阈 Telegram 告警。
 *
 * 阈值(GB)可 env 覆盖:DB_SIZE_WARN_GB(默认 70)/ DB_SIZE_CRIT_GB(默认 90)。
 * 按 Supabase 计划磁盘配额设(留头寸给 WAL/临时)。
 *
 * Cron: openclaw-sentinels.yml pipeline-health job 附加步骤(每 30min,--daily-guard
 * 日内幂等只报一次)。模式镜像 trust-scorecard-snapshot.mjs。
 * Usage: node scripts/openclaw/db-size-sentinel.mjs [--daily-guard]
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

const WARN_GB = Number(process.env.DB_SIZE_WARN_GB) || 70
const CRIT_GB = Number(process.env.DB_SIZE_CRIT_GB) || 90
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID
const DAILY_GUARD = process.argv.includes('--daily-guard')

const pool = new pg.Pool({ connectionString: dbUrl, max: 1 })

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
  // 2026-07-12:去掉 DB 侧 daily-guard 表(此前 CREATE TABLE openclaw_sentinel_runs
  // 是运行时临时建表,既违反"schema 只走迁移"铁律又造成 types 漂移致 CI 挂)。
  // 现每 30min 直接评估:读操作极廉价,且只在**超阈**时告警(阈下静默,阈上是真
  // 容量危机、每 30min 提醒可接受)。DAILY_GUARD 标志保留兼容 workflow 调用,now no-op。
  void DAILY_GUARD

  const { rows } = await pool.query(`SELECT pg_database_size(current_database()) AS bytes`)
  const bytes = Number(rows[0].bytes)
  const gb = bytes / 1e9
  const { rows: top } = await pool.query(`
    SELECT n.nspname || '.' || c.relname AS rel,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p') AND n.nspname IN ('arena','public')
     ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8`)
  const topStr = top.map((t) => `  ${t.rel}: ${t.size}`).join('\n')
  console.log(
    `[db-size] ${new Date().toISOString()} total=${gb.toFixed(1)}GB (warn ${WARN_GB} / crit ${CRIT_GB})\n${topStr}`
  )

  if (gb >= CRIT_GB) {
    await sendTelegram(
      `🔴 DB 容量 CRIT: ${gb.toFixed(1)}GB ≥ ${CRIT_GB}GB。撞配额将令写入全 500。\n最大表:\n${topStr}`
    )
  } else if (gb >= WARN_GB) {
    await sendTelegram(
      `🟡 DB 容量 WARN: ${gb.toFixed(1)}GB ≥ ${WARN_GB}GB。规划扩容/归档旧分区。\n最大表:\n${topStr}`
    )
  }
  await pool.end()
}

main().catch((e) => {
  console.error('[db-size] FAILED:', e.message)
  process.exit(1)
})
