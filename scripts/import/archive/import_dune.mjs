/**
 * Dune Analytics Data Import Script
 *
 * Imports on-chain trader data from Dune Analytics into the ranking system.
 * Supports GMX, Hyperliquid, Uniswap, and DeFi wallet activity.
 *
 * Usage:
 *   node scripts/import/import_dune.mjs [platform] [period]
 *
 * Examples:
 *   node scripts/import/import_dune.mjs              # Import all platforms, all periods
 *   node scripts/import/import_dune.mjs gmx         # Import GMX only, all periods
 *   node scripts/import/import_dune.mjs gmx 30D     # Import GMX 30D only
 *   node scripts/import/import_dune.mjs all 7D      # Import all platforms, 7D only
 *
 * Required environment variables:
 *   - DUNE_API_KEY: Dune Analytics API key (需要 Analyst 或 Plus 计划，Free 无法使用 API)
 *   - SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional environment variables (for specific query IDs):
 *   - DUNE_GMX_QUERY_ID
 *   - DUNE_HYPERLIQUID_QUERY_ID
 *   - DUNE_UNISWAP_QUERY_ID
 *   - DUNE_DEFI_QUERY_ID
 *
 * 注意事项:
 *   - Dune 使用 credits 计费，不是按查询次数
 *   - Free 计划无法使用 API，必须升级到 Analyst ($349/月) 或 Plus
 *   - 建议先在 Dune 网页验证 SQL 查询后再运行此脚本
 *   - ROI 是近似值，计算方式为 PnL/保证金，可能被小额交易极端值影响
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// Configuration
const DUNE_API = 'https://api.dune.com/api/v1';
const DUNE_API_KEY = process.env.DUNE_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Validate required environment variables
if (!DUNE_API_KEY) {
  console.error('Error: DUNE_API_KEY must be set');
  console.error('Get your API key from: https://dune.com/settings/api');
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Platform configurations with Dune query IDs
// IMPORTANT: Replace these with your actual Dune query IDs after creating them
const PLATFORMS = {
  gmx: {
    source: 'dune_gmx',
    market_type: 'perp',
    queryId: process.env.DUNE_GMX_QUERY_ID || null,
    explorer: 'https://arbiscan.io/address/',
    description: 'GMX Arbitrum Perpetual Traders',
  },
  hyperliquid: {
    source: 'dune_hyperliquid',
    market_type: 'perp',
    queryId: process.env.DUNE_HYPERLIQUID_QUERY_ID || null,
    explorer: 'https://app.hyperliquid.xyz/explorer/',
    description: 'Hyperliquid Perpetual Traders',
  },
  uniswap: {
    source: 'dune_uniswap',
    market_type: 'spot',
    queryId: process.env.DUNE_UNISWAP_QUERY_ID || null,
    explorer: 'https://etherscan.io/address/',
    description: 'Uniswap DEX Traders',
  },
  defi: {
    source: 'dune_defi',
    market_type: 'web3',
    queryId: process.env.DUNE_DEFI_QUERY_ID || null,
    explorer: 'https://etherscan.io/address/',
    description: 'DeFi Active Wallets',
  },
};

const PERIODS = ['7D', '30D', '90D'];
const TARGET_COUNT = 500;

// 数据校验阈值 - 过滤异常值
const VALIDATION = {
  // ROI 范围限制（排除极端值）
  MIN_ROI: -100,      // 最大亏损 100%
  MAX_ROI: 10000,     // 最大收益 10000%（100 倍）
  // PnL 范围限制
  MIN_PNL: -10000000, // 最大亏损 1000 万美元
  MAX_PNL: 100000000, // 最大盈利 1 亿美元
  // 胜率范围
  MIN_WIN_RATE: 0,
  MAX_WIN_RATE: 100,
  // 最小交易次数（过滤低频交易者）
  MIN_TRADES: 3,
};

// Arena Score calculation
const ARENA_CONFIG = {
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  MAX_RETURN_SCORE: 70,
  MAX_PNL_SCORE: 15,
  MAX_DRAWDOWN_SCORE: 8,
  MAX_STABILITY_SCORE: 7,
  PNL_PARAMS: {
    '7D': { base: 500, coeff: 0.40 },
    '30D': { base: 2000, coeff: 0.35 },
    '90D': { base: 5000, coeff: 0.30 },
  },
};

const clip = (v, min, max) => Math.max(min, Math.min(max, v));
const safeLog1p = x => (x <= -1 ? 0 : Math.log(1 + x));
const getPeriodDays = p => (p === '7D' ? 7 : p === '30D' ? 30 : 90);

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D'];
  const days = getPeriodDays(period);
  const wr = winRate !== null && winRate !== undefined ? (winRate <= 1 ? winRate * 100 : winRate) : null;
  const intensity = (365 / days) * safeLog1p((roi || 0) / 100);
  const r0 = Math.tanh(params.tanhCoeff * intensity);
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, ARENA_CONFIG.MAX_RETURN_SCORE) : 0;
  // PnL score (0-15)
  const pnlParams = ARENA_CONFIG.PNL_PARAMS[period] || ARENA_CONFIG.PNL_PARAMS['90D'];
  let pnlScore = 0;
  if (pnl !== null && pnl !== undefined && pnl > 0) {
    const logArg = 1 + pnl / pnlParams.base;
    if (logArg > 0) {
      pnlScore = clip(ARENA_CONFIG.MAX_PNL_SCORE * Math.tanh(pnlParams.coeff * Math.log(logArg)), 0, ARENA_CONFIG.MAX_PNL_SCORE);
    }
  }
  const drawdownScore = maxDrawdown !== null
    ? clip(ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8)
    : 4;
  const stabilityScore = wr !== null
    ? clip(ARENA_CONFIG.MAX_STABILITY_SCORE * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7)
    : 3.5;
  return Math.round((returnScore + pnlScore + drawdownScore + stabilityScore) * 100) / 100;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 校验并清理交易员数据
 * 过滤掉异常值，避免榜单被极端数据污染
 */
function validateAndCleanData(row, platformKey) {
  const address = String(row.address || row.wallet || row.user_address || '').toLowerCase();

  // 地址校验
  if (!address || address.length < 10 || !address.startsWith('0x')) {
    return { valid: false, reason: 'invalid_address' };
  }

  // 提取指标
  const roi = parseFloat(row.roi_pct || row.roi || 0);
  const pnl = parseFloat(row.total_pnl || row.pnl || row.total_volume || 0);
  const winRate = row.win_rate != null ? parseFloat(row.win_rate) : null;
  const tradeCount = parseInt(row.trade_count || row.swap_count || row.tx_count || 0);

  // ROI 范围校验
  if (roi < VALIDATION.MIN_ROI || roi > VALIDATION.MAX_ROI) {
    return { valid: false, reason: `roi_out_of_range: ${roi}` };
  }

  // PnL 范围校验
  if (pnl < VALIDATION.MIN_PNL || pnl > VALIDATION.MAX_PNL) {
    return { valid: false, reason: `pnl_out_of_range: ${pnl}` };
  }

  // 胜率范围校验
  if (winRate != null && (winRate < VALIDATION.MIN_WIN_RATE || winRate > VALIDATION.MAX_WIN_RATE)) {
    return { valid: false, reason: `win_rate_out_of_range: ${winRate}` };
  }

  // 最小交易次数校验（Uniswap 等 spot DEX 可以放宽）
  const minTrades = platformKey === 'uniswap' ? 1 : VALIDATION.MIN_TRADES;
  if (tradeCount < minTrades) {
    return { valid: false, reason: `insufficient_trades: ${tradeCount}` };
  }

  return {
    valid: true,
    data: { address, roi, pnl, winRate, tradeCount }
  };
}

/**
 * Execute a Dune query and wait for results
 */
async function executeDuneQuery(queryId, params = {}) {
  console.log(`  Executing Dune query ${queryId}...`);

  // Build URL with params
  let executeUrl = `${DUNE_API}/query/${queryId}/execute`;
  if (Object.keys(params).length > 0) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      searchParams.set(`query_parameters.${key}`, value);
    });
    executeUrl += `?${searchParams.toString()}`;
  }

  // Execute query
  const executeResponse = await fetch(executeUrl, {
    method: 'POST',
    headers: {
      'x-dune-api-key': DUNE_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!executeResponse.ok) {
    const error = await executeResponse.text();
    throw new Error(`Failed to execute query: ${error}`);
  }

  const { execution_id } = await executeResponse.json();
  console.log(`  Execution ID: ${execution_id}`);

  // Poll for results (max 120 seconds for complex queries)
  const maxWait = 120000;
  const pollInterval = 5000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    await sleep(pollInterval);

    const statusUrl = `${DUNE_API}/execution/${execution_id}/status`;
    const statusResponse = await fetch(statusUrl, {
      headers: { 'x-dune-api-key': DUNE_API_KEY },
    });

    const status = await statusResponse.json();
    console.log(`  Query status: ${status.state}`);

    if (status.state === 'QUERY_STATE_COMPLETED') {
      // Fetch full results
      const resultsUrl = `${DUNE_API}/execution/${execution_id}/results`;
      const resultsResponse = await fetch(resultsUrl, {
        headers: { 'x-dune-api-key': DUNE_API_KEY },
      });
      return resultsResponse.json();
    }

    if (status.state === 'QUERY_STATE_FAILED') {
      throw new Error(`Query failed: ${status.error || 'Unknown error'}`);
    }
  }

  throw new Error(`Query timed out after ${maxWait / 1000} seconds`);
}

/**
 * Fetch cached results (faster, doesn't count against query limit)
 */
async function fetchCachedResults(queryId) {
  console.log(`  Fetching cached results for query ${queryId}...`);

  const url = `${DUNE_API}/query/${queryId}/results`;
  const response = await fetch(url, {
    headers: { 'x-dune-api-key': DUNE_API_KEY },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch cached results: ${error}`);
  }

  return response.json();
}

/**
 * Import data for a specific platform and period
 */
async function importPlatformData(platformKey, period) {
  const platform = PLATFORMS[platformKey];

  if (!platform.queryId) {
    console.log(`\n⚠ Skipping ${platformKey}: No query ID configured`);
    console.log(`  Set DUNE_${platformKey.toUpperCase()}_QUERY_ID in your environment`);
    return { saved: 0, errors: 0, skipped: true };
  }

  console.log(`\n=== Importing ${platform.description} (${period}) ===`);
  console.log(`Query ID: ${platform.queryId}`);

  try {
    // Try cached results first
    let result;
    try {
      result = await fetchCachedResults(platform.queryId);
    } catch (e) {
      console.log(`  No cached results, executing fresh query...`);
      result = await executeDuneQuery(platform.queryId, {
        days: getPeriodDays(period).toString(),
      });
    }

    if (!result?.result?.rows?.length) {
      console.log(`  No data returned from query`);
      return { saved: 0, errors: 0, skipped: false };
    }

    const rows = result.result.rows.slice(0, TARGET_COUNT);
    console.log(`  Found ${rows.length} traders`);

    // Process and save traders
    const capturedAt = new Date().toISOString();
    let saved = 0;
    let errors = 0;
    let filtered = 0;
    const filterReasons = {};

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // 数据校验
      const validation = validateAndCleanData(row, platformKey);
      if (!validation.valid) {
        filtered++;
        const reason = validation.reason.split(':')[0];
        filterReasons[reason] = (filterReasons[reason] || 0) + 1;
        continue;
      }

      const { address, roi, pnl, winRate, tradeCount } = validation.data;

      try {
        // Calculate Arena Score
        const arenaScore = calculateArenaScore(roi, pnl, null, winRate, period);

        // Upsert trader source
        await supabase.from('trader_sources').upsert({
          source: platform.source,
          source_type: 'leaderboard',
          source_trader_id: address,
          handle: address.slice(0, 10) + '...',
          is_active: true,
        }, { onConflict: 'source,source_trader_id' });

        // Insert snapshot
        const { error } = await supabase.from('trader_snapshots').insert({
          source: platform.source,
          source_trader_id: address,
          season_id: period,
          rank: i + 1,
          roi: roi || null,
          pnl: pnl || null,
          win_rate: winRate,
          max_drawdown: null,
          followers: null,
          arena_score: arenaScore,
          captured_at: capturedAt,
          raw_data: row,
        });

        if (error) {
          errors++;
        } else {
          saved++;
        }
      } catch (e) {
        errors++;
      }

      // Progress indicator
      if ((i + 1) % 100 === 0) {
        console.log(`  Processed ${i + 1}/${rows.length}`);
      }
    }

    console.log(`  ✓ Saved: ${saved}, Errors: ${errors}, Filtered: ${filtered}`);
    if (filtered > 0) {
      console.log(`  Filter reasons:`, filterReasons);
    }
    return { saved, errors, filtered, skipped: false };

  } catch (error) {
    console.error(`  ✗ Error: ${error.message}`);
    // 检查是否是 API 访问权限问题
    if (error.message.includes('401') || error.message.includes('403')) {
      console.error(`  ⚠ 提示: Free 计划无法使用 Dune API，需要升级到 Analyst 或 Plus`);
    }
    return { saved: 0, errors: 1, filtered: 0, skipped: false };
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const targetPlatform = args[0]?.toLowerCase();
  const targetPeriod = args[1]?.toUpperCase();

  // Determine which platforms to import
  const platformKeys = targetPlatform && targetPlatform !== 'all'
    ? [targetPlatform]
    : Object.keys(PLATFORMS);

  // Determine which periods to import
  const periods = targetPeriod && PERIODS.includes(targetPeriod)
    ? [targetPeriod]
    : PERIODS;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Dune Analytics Data Import`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Platforms: ${platformKeys.join(', ')}`);
  console.log(`Periods: ${periods.join(', ')}`);
  console.log(`Target traders per platform/period: ${TARGET_COUNT}`);
  console.log(`${'='.repeat(60)}`);

  const results = [];
  const startTime = Date.now();

  for (const platformKey of platformKeys) {
    if (!PLATFORMS[platformKey]) {
      console.log(`\n⚠ Unknown platform: ${platformKey}`);
      continue;
    }

    for (const period of periods) {
      const result = await importPlatformData(platformKey, period);
      results.push({
        platform: platformKey,
        period,
        ...result,
      });

      // Rate limiting between requests
      if (!result.skipped) {
        console.log(`  Waiting 12s before next request (rate limit)...`);
        await sleep(12000);
      }
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Import Complete`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Results:`);

  let totalSaved = 0;
  let totalErrors = 0;
  let totalFiltered = 0;
  let totalSkipped = 0;

  for (const r of results) {
    const status = r.skipped
      ? '(skipped - no query ID)'
      : `${r.saved} saved, ${r.errors} errors, ${r.filtered || 0} filtered`;
    console.log(`  ${r.platform} ${r.period}: ${status}`);
    totalSaved += r.saved || 0;
    totalErrors += r.errors || 0;
    totalFiltered += r.filtered || 0;
    if (r.skipped) totalSkipped++;
  }

  console.log(`\nTotals: ${totalSaved} saved, ${totalErrors} errors, ${totalFiltered} filtered, ${totalSkipped} skipped`);
  console.log(`Duration: ${totalTime}s`);
  console.log(`${'='.repeat(60)}`);

  // Instructions for missing query IDs
  const missingQueries = Object.entries(PLATFORMS)
    .filter(([_, p]) => !p.queryId)
    .map(([k]) => k);

  if (missingQueries.length > 0) {
    console.log(`\n⚠ Some platforms were skipped due to missing query IDs.`);
    console.log(`To import these platforms, create Dune queries and set the query IDs:`);
    for (const key of missingQueries) {
      console.log(`  DUNE_${key.toUpperCase()}_QUERY_ID=<query_id>`);
    }
    console.log(`\nSee the connector files for example SQL queries:`);
    console.log(`  connectors/dune/gmx.ts`);
    console.log(`  connectors/dune/hyperliquid.ts`);
    console.log(`  connectors/dune/uniswap.ts`);
    console.log(`  connectors/dune/defi.ts`);
  }
}

main().catch(console.error);
