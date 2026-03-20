#!/usr/bin/env node
/**
 * Comprehensive fill rate audit for trader detail page.
 * Checks every data field across all platforms for 3 tabs.
 */
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ─── Tab 1: Overview (leaderboard_ranks + trader_stats_detail) ─────────────

async function auditOverview() {
  console.log('\n═══════════════════════════════════════════════════')
  console.log('  TAB 1: OVERVIEW — leaderboard_ranks fill rates')
  console.log('═══════════════════════════════════════════════════\n')

  const { data, error } = await supabase.rpc('exec_sql', {
    query: `
      SELECT
        source,
        season_id,
        COUNT(*) as total,
        COUNT(roi) as has_roi,
        COUNT(pnl) as has_pnl,
        COUNT(win_rate) as has_win_rate,
        COUNT(max_drawdown) as has_max_drawdown,
        COUNT(trades_count) as has_trades_count,
        COUNT(followers) as has_followers,
        COUNT(sharpe_ratio) as has_sharpe,
        COUNT(arena_score) as has_arena_score,
        COUNT(profitability_score) as has_profit_score,
        COUNT(risk_control_score) as has_risk_score,
        COUNT(execution_score) as has_exec_score,
        COUNT(avg_holding_hours) as has_avg_holding,
        COUNT(trading_style) as has_trading_style,
        COUNT(handle) as has_handle,
        COUNT(avatar_url) as has_avatar
      FROM leaderboard_ranks
      WHERE computed_at > NOW() - INTERVAL '48 hours'
      GROUP BY source, season_id
      ORDER BY source, season_id
    `
  })

  if (error) {
    // Fallback: direct query
    console.log('RPC not available, using direct queries...\n')
    await auditOverviewDirect()
    return
  }
  printTable(data)
}

async function auditOverviewDirect() {
  // Get platforms
  const { data: platforms } = await supabase
    .from('leaderboard_ranks')
    .select('source')
    .gt('computed_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())
    .limit(1000)

  const uniquePlatforms = [...new Set(platforms?.map(p => p.source) || [])]
  console.log(`Active platforms: ${uniquePlatforms.length}\n`)

  const fields = [
    'roi', 'pnl', 'win_rate', 'max_drawdown', 'trades_count',
    'followers', 'sharpe_ratio', 'arena_score',
    'profitability_score', 'risk_control_score', 'execution_score',
    'avg_holding_hours', 'trading_style', 'handle', 'avatar_url'
  ]

  for (const platform of uniquePlatforms.sort()) {
    for (const period of ['7D', '30D', '90D']) {
      // Get total count
      const { count: total } = await supabase
        .from('leaderboard_ranks')
        .select('*', { count: 'exact', head: true })
        .eq('source', platform)
        .eq('season_id', period)
        .gt('computed_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())

      if (!total) continue

      const results = { platform, period, total }

      for (const field of fields) {
        const { count } = await supabase
          .from('leaderboard_ranks')
          .select('*', { count: 'exact', head: true })
          .eq('source', platform)
          .eq('season_id', period)
          .gt('computed_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())
          .not(field, 'is', null)

        const pct = ((count / total) * 100).toFixed(1)
        results[field] = `${count}/${total} (${pct}%)`
        if (parseFloat(pct) < 100) {
          results[field] += ' ⚠️'
        }
      }

      console.log(`\n--- ${platform} | ${period} | ${total} traders ---`)
      for (const field of fields) {
        if (results[field]) {
          console.log(`  ${field.padEnd(22)} ${results[field]}`)
        }
      }
    }
  }
}

// ─── Tab 1: Overview Advanced Metrics (trader_stats_detail) ────────────────

async function auditAdvancedMetrics() {
  console.log('\n\n═══════════════════════════════════════════════════')
  console.log('  TAB 1: OVERVIEW — trader_stats_detail fill rates')
  console.log('═══════════════════════════════════════════════════\n')

  const { data: platforms } = await supabase
    .from('leaderboard_ranks')
    .select('source')
    .gt('computed_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())
    .limit(1000)

  const uniquePlatforms = [...new Set(platforms?.map(p => p.source) || [])]

  const fields = [
    'sharpe_ratio', 'total_trades', 'profitable_trades_pct',
    'avg_holding_time_hours', 'avg_profit', 'avg_loss',
    'largest_win', 'largest_loss', 'max_drawdown',
    'current_drawdown', 'volatility', 'copiers_count',
    'copiers_pnl', 'aum', 'winning_positions', 'total_positions'
  ]

  for (const platform of uniquePlatforms.sort()) {
    // Count traders on leaderboard
    const { count: lbCount } = await supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', platform)
      .eq('season_id', '90D')
      .gt('computed_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())

    if (!lbCount) continue

    for (const period of ['7D', '30D', '90D']) {
      // Count enriched
      const { count: enrichedCount } = await supabase
        .from('trader_stats_detail')
        .select('*', { count: 'exact', head: true })
        .eq('source', platform)
        .eq('period', period)
        .gt('captured_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())

      if (!enrichedCount) {
        console.log(`\n--- ${platform} | ${period} | 0/${lbCount} enriched ❌ ---`)
        continue
      }

      console.log(`\n--- ${platform} | ${period} | ${enrichedCount}/${lbCount} enriched ---`)

      for (const field of fields) {
        const { count } = await supabase
          .from('trader_stats_detail')
          .select('*', { count: 'exact', head: true })
          .eq('source', platform)
          .eq('period', period)
          .gt('captured_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())
          .not(field, 'is', null)

        const pct = ((count / enrichedCount) * 100).toFixed(1)
        const flag = parseFloat(pct) < 100 ? ' ⚠️' : ''
        console.log(`  ${field.padEnd(26)} ${count}/${enrichedCount} (${pct}%)${flag}`)
      }
    }
  }
}

// ─── Tab 1: Equity Curve ───────────────────────────────────────────────────

async function auditEquityCurve() {
  console.log('\n\n═══════════════════════════════════════════════════')
  console.log('  TAB 1+2: EQUITY CURVE fill rates')
  console.log('═══════════════════════════════════════════════════\n')

  const { data: platforms } = await supabase
    .from('leaderboard_ranks')
    .select('source')
    .gt('computed_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())
    .limit(1000)

  const uniquePlatforms = [...new Set(platforms?.map(p => p.source) || [])]

  for (const platform of uniquePlatforms.sort()) {
    const { count: lbCount } = await supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', platform)
      .eq('season_id', '90D')
      .gt('computed_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())

    if (!lbCount) continue

    const results = []
    for (const period of ['7D', '30D', '90D']) {
      // Count distinct traders with equity curve data
      const { data: ecTraders } = await supabase
        .from('trader_equity_curve')
        .select('source_trader_id')
        .eq('source', platform)
        .eq('period', period)
        .gt('captured_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())
        .limit(10000)

      const uniqueTraders = new Set(ecTraders?.map(e => e.source_trader_id) || [])
      const pct = ((uniqueTraders.size / lbCount) * 100).toFixed(1)
      const flag = parseFloat(pct) < 90 ? ' ⚠️' : ''
      results.push(`${period}: ${uniqueTraders.size}/${lbCount} (${pct}%)${flag}`)
    }

    console.log(`  ${platform.padEnd(20)} ${results.join('  |  ')}`)
  }
}

// ─── Tab 2: Stats (Asset Breakdown) ────────────────────────────────────────

async function auditAssetBreakdown() {
  console.log('\n\n═══════════════════════════════════════════════════')
  console.log('  TAB 2: STATS — asset_breakdown fill rates')
  console.log('═══════════════════════════════════════════════════\n')

  const { data: platforms } = await supabase
    .from('leaderboard_ranks')
    .select('source')
    .gt('computed_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())
    .limit(1000)

  const uniquePlatforms = [...new Set(platforms?.map(p => p.source) || [])]

  for (const platform of uniquePlatforms.sort()) {
    const { count: lbCount } = await supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', platform)
      .eq('season_id', '90D')
      .gt('computed_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())

    if (!lbCount) continue

    const results = []
    for (const period of ['7D', '30D', '90D']) {
      const { data: abTraders } = await supabase
        .from('trader_asset_breakdown')
        .select('source_trader_id')
        .eq('source', platform)
        .eq('period', period)
        .gt('captured_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())
        .limit(10000)

      const uniqueTraders = new Set(abTraders?.map(e => e.source_trader_id) || [])
      const pct = ((uniqueTraders.size / lbCount) * 100).toFixed(1)
      const flag = parseFloat(pct) < 90 ? ' ⚠️' : ''
      results.push(`${period}: ${uniqueTraders.size}/${lbCount} (${pct}%)${flag}`)
    }

    console.log(`  ${platform.padEnd(20)} ${results.join('  |  ')}`)
  }
}

// ─── Tab 3: Portfolio ──────────────────────────────────────────────────────

async function auditPortfolio() {
  console.log('\n\n═══════════════════════════════════════════════════')
  console.log('  TAB 3: PORTFOLIO — current positions & history')
  console.log('═══════════════════════════════════════════════════\n')

  const { data: platforms } = await supabase
    .from('leaderboard_ranks')
    .select('source')
    .gt('computed_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())
    .limit(1000)

  const uniquePlatforms = [...new Set(platforms?.map(p => p.source) || [])]

  for (const platform of uniquePlatforms.sort()) {
    const { count: lbCount } = await supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', platform)
      .eq('season_id', '90D')
      .gt('computed_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())

    if (!lbCount) continue

    // Current positions
    const { data: portfolioTraders } = await supabase
      .from('trader_portfolio')
      .select('source_trader_id')
      .eq('source', platform)
      .gt('captured_at', new Date(Date.now() - 72 * 3600 * 1000).toISOString())
      .limit(10000)

    const uniquePortfolio = new Set(portfolioTraders?.map(e => e.source_trader_id) || [])

    // Position history
    const { data: historyTraders } = await supabase
      .from('trader_position_history')
      .select('source_trader_id')
      .eq('source', platform)
      .gt('captured_at', new Date(Date.now() - 72 * 3600 * 1000).toISOString())
      .limit(10000)

    const uniqueHistory = new Set(historyTraders?.map(e => e.source_trader_id) || [])

    const portfolioPct = ((uniquePortfolio.size / lbCount) * 100).toFixed(1)
    const historyPct = ((uniqueHistory.size / lbCount) * 100).toFixed(1)
    const pFlag = parseFloat(portfolioPct) < 50 ? ' ⚠️' : ''
    const hFlag = parseFloat(historyPct) < 50 ? ' ⚠️' : ''

    console.log(`  ${platform.padEnd(20)} Portfolio: ${uniquePortfolio.size}/${lbCount} (${portfolioPct}%)${pFlag}  |  History: ${uniqueHistory.size}/${lbCount} (${historyPct}%)${hFlag}`)
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍 Arena Trader Detail Page — Full Fill Rate Audit')
  console.log('Date:', new Date().toISOString())
  console.log('Window: last 48 hours\n')

  await auditOverview()
  await auditAdvancedMetrics()
  await auditEquityCurve()
  await auditAssetBreakdown()
  await auditPortfolio()

  console.log('\n\n✅ Audit complete.')
}

main().catch(console.error)
