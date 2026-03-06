/**
 * Aevo Enrichment v2 - Investigation Script
 * 
 * FINDINGS (from exhaustive API investigation):
 * 
 * 1. PUBLIC ENDPOINTS TESTED:
 *    - https://api.aevo.xyz/leaderboard → Returns: ranking, username, pnl, options_volume, perp_volume ONLY
 *    - https://api.aevo.xyz/strategies → Returns max_drawdown for only 2 copy-trading strategies (ETH addresses)
 *    - https://api.aevo.xyz/statistics → Returns global volume stats (not per-user)
 *    - https://api.aevo.xyz/strategy/{addr}/pnl-history → [timestamp, pnl] pairs (public, no auth needed)
 *    - https://api.aevo.xyz/strategy/{addr}/portfolio → Balance/sharpe data (public, no auth needed)
 *    - https://api.aevo.xyz/strategy/{addr}/trade-history → Individual trade history (public, no auth needed)
 * 
 * 2. WHAT DOESN'T EXIST (all 404):
 *    - /copy-trading/leaderboard
 *    - /account/{username}/stats
 *    - /account/{username}/trade-history
 *    - /strategies/leaderboard
 *    - All per-user endpoints (require AEVO-KEY + AEVO-SECRET)
 * 
 * 3. THE PROBLEM:
 *    - The DB has 1107 Aevo traders (source='aevo') with usernames like 'pushy-mud-cronje'
 *    - These are LEADERBOARD traders, not copy-trading strategy managers
 *    - Copy-trading strategies use ETH addresses (only 2 exist publicly)
 *    - The 2 strategies do NOT match any leaderboard trader usernames
 *    - win_rate and max_drawdown require auth for per-user endpoints
 * 
 * 4. WHAT WE CAN GET:
 *    - The /strategies endpoint provides max_drawdown for 2 strategies
 *    - These strategies' trade_history can compute win_rate
 *    - But these don't help with the 326 null-win_rate leaderboard traders
 * 
 * CONCLUSION: No real API data is available for win_rate/max_drawdown of
 * Aevo leaderboard traders without authentication credentials.
 * 
 * Per the rules: DO NOT FABRICATE DATA.
 * This script documents the investigation and computes what IS possible
 * from public APIs: max_drawdown and win_rate for copy-trading strategies.
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchJson(url, timeout = 15000) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * For copy-trading strategies, compute win_rate from trade history.
 * Each trade has a pnl field; win = pnl > 0 (excluding fees).
 */
async function computeWinRateFromTradeHistory(strategyAddr) {
  let page = 0;
  const limit = 100;
  let wins = 0, total = 0;
  let hasMore = true;

  while (hasMore && page < 10) { // Cap at 1000 trades
    const url = `https://api.aevo.xyz/strategy/${strategyAddr}/trade-history?limit=${limit}&offset=${page * limit}`;
    const data = await fetchJson(url);
    if (!data?.trade_history?.length) break;

    for (const trade of data.trade_history) {
      if (trade.trade_status !== 'filled') continue;
      total++;
      const pnl = parseFloat(trade.pnl || '0');
      const fees = parseFloat(trade.fees || '0');
      // Win if pnl (net of fees) > 0
      if (pnl - fees > 0) wins++;
    }

    if (data.trade_history.length < limit) hasMore = false;
    page++;
  }

  return total > 0 ? Math.round((wins / total) * 10000) / 100 : null;
}

/**
 * From pnl-history [timestamp, pnl] pairs, compute max drawdown.
 */
function computeMaxDrawdown(history) {
  if (!history?.length) return null;

  let maxPnl = -Infinity;
  let maxDrawdown = 0;

  for (const [, pnlStr] of history) {
    const pnl = parseFloat(pnlStr);
    if (pnl > maxPnl) maxPnl = pnl;
    if (maxPnl > 0) {
      const drawdown = (maxPnl - pnl) / maxPnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }

  return Math.round(maxDrawdown * 10000) / 100; // as percentage
}

async function main() {
  console.log('=== Aevo Enrichment v2 Investigation ===\n');

  // Step 1: Check DB stats
  const { count: nullWrCount } = await sb.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'aevo')
    .is('win_rate', null);
  
  const { count: nullMddCount } = await sb.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'aevo')
    .is('max_drawdown', null);

  console.log(`DB Status:`);
  console.log(`  win_rate IS NULL:    ${nullWrCount} rows`);
  console.log(`  max_drawdown IS NULL: ${nullMddCount} rows\n`);

  // Step 2: Fetch public copy-trading strategies
  console.log('Fetching public copy-trading strategies...');
  const strategiesData = await fetchJson('https://api.aevo.xyz/strategies');
  const strategies = strategiesData?.strategies || [];
  console.log(`Found ${strategies.length} public copy-trading strategies\n`);

  for (const strategy of strategies) {
    console.log(`Strategy: ${strategy.strategy_name} (${strategy.strategy_address})`);
    console.log(`  max_drawdown from API: ${strategy.max_drawdown} (${(parseFloat(strategy.max_drawdown) * 100).toFixed(2)}%)`);
    console.log(`  past_month_return:     ${strategy.past_month_return}`);
    console.log(`  AUM:                   ${strategy.aum}`);

    // Compute win_rate from trade history
    console.log(`  Computing win_rate from trade history...`);
    const winRate = await computeWinRateFromTradeHistory(strategy.strategy_address);
    console.log(`  Computed win_rate:     ${winRate}%`);

    // Compute MDD from pnl-history  
    console.log(`  Computing max_drawdown from pnl-history...`);
    const pnlData = await fetchJson(`https://api.aevo.xyz/strategy/${strategy.strategy_address}/pnl-history?start_time=0`);
    const computedMdd = computeMaxDrawdown(pnlData?.history);
    console.log(`  Computed max_drawdown: ${computedMdd}%`);
    console.log();
  }

  // Step 3: Check if strategy addresses match any DB trader IDs
  const strategyAddresses = strategies.map(s => s.strategy_address.toLowerCase());
  console.log('\nChecking if strategy addresses match any DB trader IDs...');
  
  const { data: matchingTraders } = await sb.from('leaderboard_ranks')
    .select('source_trader_id, win_rate, max_drawdown')
    .eq('source', 'aevo')
    .in('source_trader_id', strategyAddresses);
  
  console.log(`Matching traders found: ${matchingTraders?.length || 0}`);
  
  if (matchingTraders?.length > 0) {
    console.log('Matches:', matchingTraders);
    // Could update these if we had any matches
  }

  console.log('\n=== FINAL REPORT ===');
  console.log('');
  console.log('RESULT: No real API data is available for win_rate or max_drawdown');
  console.log('of Aevo leaderboard traders (source=aevo, username format IDs).');
  console.log('');
  console.log('REASON:');
  console.log('  - Aevo leaderboard API only provides: rank, username, pnl, volume');
  console.log('  - Per-account stats (win_rate, MDD) require AEVO-KEY + AEVO-SECRET auth');
  console.log('  - The 2 public copy-trading strategies use ETH addresses (not usernames)');
  console.log('  - Strategy addresses do NOT match any leaderboard trader IDs in DB');
  console.log('');
  console.log('ROWS UPDATED: 0 (no real data source found)');
  console.log('');
  console.log('RECOMMENDATION: Either obtain Aevo API credentials for private endpoints,');
  console.log('or accept that these metrics cannot be populated for Aevo leaderboard traders.');
}

main().catch(e => { console.error(e); process.exit(1); });
