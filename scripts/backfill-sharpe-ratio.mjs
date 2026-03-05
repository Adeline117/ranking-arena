#!/usr/bin/env node
/**
 * Backfill sharpe_ratio for trader_snapshots
 *
 * Calculates sharpe_ratio from trader_equity_curve data and updates trader_snapshots
 *
 * Usage:
 *   node scripts/backfill-sharpe-ratio.mjs [--platform=xxx] [--limit=100] [--dry-run]
 */

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load env
function loadEnv() {
  const envPath = join(__dirname, '..', '.env.local')
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^=]+)=["']?(.+?)["']?$/)
      if (match) {
        process.env[match[1]] = match[2]
      }
    }
  } catch (e) {
    console.error('Failed to load .env.local:', e.message)
  }
}

loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

// Parse command line args
const args = process.argv.slice(2)
const platform = args.find(a => a.startsWith('--platform='))?.split('=')[1]
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '100')
const dryRun = args.includes('--dry-run')

/**
 * Calculate Sharpe ratio from equity curve data
 * @param {Array<{roi_pct: number}>} curve
 * @returns {number|null}
 */
function calculateSharpeRatio(curve) {
  if (!curve || curve.length < 7) return null

  // Calculate daily returns
  const returns = []
  for (let i = 1; i < curve.length; i++) {
    const dailyReturn = curve[i].roi_pct - curve[i - 1].roi_pct
    returns.push(dailyReturn)
  }

  if (returns.length < 5) return null

  // Mean daily return
  const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length

  // Standard deviation of daily returns
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length
  const stdDev = Math.sqrt(variance)

  if (stdDev === 0) return null

  // Annualize (approximate - assume 365 trading days)
  const annualizationFactor = Math.sqrt(365)
  const sharpe = (meanReturn / stdDev) * annualizationFactor

  // Sanity check
  return sharpe > -10 && sharpe < 10 ? Math.round(sharpe * 100) / 100 : null
}

async function query(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=minimal',
    },
    ...options,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API error: ${res.status} ${text}`)
  }

  return res.status === 204 ? null : res.json()
}

async function main() {
  console.log('=== Sharpe Ratio Backfill ===')
  console.log(`Platform: ${platform || 'all'}`)
  console.log(`Limit: ${limit}`)
  console.log(`Dry run: ${dryRun}`)
  console.log('')

  // Get snapshots without sharpe_ratio
  let url = '/trader_snapshots?sharpe_ratio=is.null&select=id,source,source_trader_id,season_id'
  if (platform) {
    url += `&source=eq.${platform}`
  }
  url += `&limit=${limit}&order=arena_score.desc.nullslast`

  const snapshots = await query(url)
  console.log(`Found ${snapshots.length} snapshots without sharpe_ratio`)

  let updated = 0
  let skipped = 0
  let failed = 0

  for (const snapshot of snapshots) {
    const { id, source, source_trader_id, season_id } = snapshot

    try {
      // Get equity curve for this trader
      const curveUrl = `/trader_equity_curve?source=eq.${source}&source_trader_id=eq.${source_trader_id}&period=eq.${season_id}&select=roi_pct,data_date&order=data_date.asc`
      const curve = await query(curveUrl)

      if (!curve || curve.length < 7) {
        skipped++
        continue
      }

      const sharpeRatio = calculateSharpeRatio(curve)

      if (sharpeRatio === null) {
        skipped++
        continue
      }

      if (dryRun) {
        console.log(`[DRY RUN] Would update ${source}/${source_trader_id} sharpe_ratio=${sharpeRatio}`)
        updated++
      } else {
        await query(`/trader_snapshots?id=eq.${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ sharpe_ratio: sharpeRatio }),
        })
        console.log(`Updated ${source}/${source_trader_id} sharpe_ratio=${sharpeRatio}`)
        updated++
      }
    } catch (err) {
      console.error(`Failed to update ${source}/${source_trader_id}: ${err.message}`)
      failed++
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 50))
  }

  console.log('')
  console.log('=== Summary ===')
  console.log(`Updated: ${updated}`)
  console.log(`Skipped (insufficient data): ${skipped}`)
  console.log(`Failed: ${failed}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
