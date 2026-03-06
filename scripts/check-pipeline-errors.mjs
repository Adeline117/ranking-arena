#!/usr/bin/env node
/**
 * Check pipeline_metrics for recent errors on stale platforms
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '../.env.local')

try {
  for (const l of readFileSync(envPath, 'utf8').split('\n')) {
    const m = l.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const stalePlatforms = [
  'binance_futures', 'binance_spot', 'bybit', 'bitget_futures',
  'htx_futures', 'bingx', 'gateio', 'okx_web3', 'phemex', 'weex'
]

for (const src of stalePlatforms) {
  const { data, error } = await supabase
    .from('pipeline_metrics')
    .select('metric_type, value, metadata, created_at')
    .eq('source', src)
    .order('created_at', { ascending: false })
    .limit(5)

  console.log(`\n=== ${src} ===`)
  if (error) { console.log('Error:', error.message); continue }
  if (!data || data.length === 0) { console.log('No metrics found'); continue }
  for (const r of data) {
    const age = Math.round((Date.now() - new Date(r.created_at).getTime()) / 3600000)
    const meta = r.metadata?.error
      ? r.metadata.error.toString().slice(0, 120)
      : JSON.stringify(r.metadata || {}).slice(0, 120)
    console.log(`  ${age}h ago | ${r.metric_type.padEnd(15)} | val=${r.value} | ${meta}`)
  }
}

// Also check cron_logs
console.log('\n\n=== Recent cron_logs (batch-fetch-traders) ===')
const { data: cronLogs, error: cronErr } = await supabase
  .from('cron_logs')
  .select('name, ran_at, result')
  .like('name', '%fetch%')
  .order('ran_at', { ascending: false })
  .limit(15)

if (cronErr) {
  console.log('cron_logs error:', cronErr.message)
} else if (!cronLogs || cronLogs.length === 0) {
  console.log('No cron_logs found')
} else {
  for (const log of cronLogs) {
    const age = Math.round((Date.now() - new Date(log.ran_at).getTime()) / 3600000)
    const result = typeof log.result === 'string' ? log.result.slice(0, 100) : JSON.stringify(log.result || {}).slice(0, 100)
    console.log(`  ${age}h ago | ${log.name} | ${result}`)
  }
}
