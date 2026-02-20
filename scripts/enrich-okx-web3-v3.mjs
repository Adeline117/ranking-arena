#!/usr/bin/env node
/**
 * OKX Web3 Win Rate enrichment - v3
 *
 * Problem: 1145 traders have null win_rate because the leaderboard is dynamic
 * - DB has truncated addresses (e.g. "GkRZz7...ybzz") captured at import time
 * - Rankings change, so the trader at rank 205 now ≠ trader at rank 205 when imported
 * - Must fetch ALL available traders from API to build a complete lookup map
 *
 * Strategy:
 * 1. Fetch ALL traders from OKX ranking API (chainId=501, all periods, all pages up to 4000)
 * 2. Also try chainId=1 (ETH) and chainId=56 (BSC) for edge cases
 * 3. Build truncated_address → {winRate, mdd, tx} lookup
 * 4. Match DB null WR records by truncated address
 * 5. Update matched records
 *
 * Usage:
 *   node scripts/enrich-okx-web3-v3.mjs
 *   node scripts/enrich-okx-web3-v3.mjs --dry-run
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const DRY_RUN = process.argv.includes('--dry-run');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content';
const PERIOD_MAP = { '7D': '1', '30D': '2', '90D': '3' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

function truncateAddress(addr) {
  if (!addr || addr.length < 11) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function computeMDD(pnlHistory) {
  if (!pnlHistory?.length || pnlHistory.length < 2) return null;
  const values = pnlHistory.map(h => parseFloat(h.pnl)).filter(v => !isNaN(v));
  if (values.length < 2) return null;
  let peak = values[0], maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD > 0 && maxDD <= 100 ? parseFloat(maxDD.toFixed(2)) : null;
}

async function fetchJSON(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      if (i < retries - 1) await sleep(1000 * (i + 1));
    }
  }
  return null;
}

/**
 * Fetch ALL traders for a given period and chain ID.
 * Returns a Map: truncated_address → {winRate, mdd, tx}
 */
async function fetchAllTradersForPeriodAndChain(periodType, chainId) {
  const all = new Map();
  let emptyCount = 0;

  for (let start = 0; start < 5000; start += 20) {
    const url = `${BASE}?rankStart=${start}&periodType=${periodType}&rankBy=1&label=all&desc=true&rankEnd=${start + 20}&chainId=${chainId}`;
    const json = await fetchJSON(url);
    const infos = json?.data?.rankingInfos || [];

    if (infos.length === 0) {
      emptyCount++;
      if (emptyCount >= 3) break; // 3 consecutive empty pages = end of data
      await sleep(300);
      continue;
    }
    emptyCount = 0;

    for (const t of infos) {
      const addr = t.walletAddress;
      if (!addr) continue;
      const trunc = truncateAddress(addr);
      if (all.has(trunc)) continue; // don't overwrite existing
      all.set(trunc, {
        winRate: t.winRate != null ? parseFloat(t.winRate) : null,
        mdd: computeMDD(t.pnlHistory),
        tx: t.tx != null ? parseInt(t.tx) : null,
      });
    }

    if (start % 500 === 0 && start > 0) {
      process.stdout.write(`    ... ${start} scanned, ${all.size} unique traders\r`);
    }
    await sleep(150);
  }
  return all;
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('OKX Web3 — Win Rate Enrichment v3');
  if (DRY_RUN) console.log('[DRY RUN MODE]');
  console.log('='.repeat(60));

  // Step 1: Get all null WR rows from DB
  console.log('\n[1] Fetching null WR records from DB...');
  let allRows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'okx_web3')
      .is('win_rate', null)
      .range(offset, offset + 999);
    if (error) { console.error('DB error:', error.message); break; }
    if (!data?.length) break;
    allRows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`  Found ${allRows.length} rows with null win_rate`);
  if (!allRows.length) { console.log('Nothing to do!'); return; }

  // Group by season_id for efficient matching
  const bySeason = {};
  for (const row of allRows) {
    if (!bySeason[row.season_id]) bySeason[row.season_id] = [];
    bySeason[row.season_id].push(row);
  }
  console.log('  By season:', Object.entries(bySeason).map(([k, v]) => `${k}:${v.length}`).join(', '));

  // Build a set of all null-WR truncated IDs for quick lookup
  const nullIds = new Set(allRows.map(r => r.source_trader_id));
  console.log(`  Unique addresses with null WR: ${nullIds.size}`);

  // Step 2: Fetch from OKX API — all periods, multiple chains
  console.log('\n[2] Fetching from OKX API...');
  // Key: truncated_addr, value: {winRate, mdd, tx}
  const bigMap = new Map();

  // Chains to try: SOL is primary (all addresses are base58 Solana), but try ETH/BSC too
  const chains = [501, 1, 56, 8453];

  for (const [period, periodType] of Object.entries(PERIOD_MAP)) {
    if (!bySeason[period]) {
      console.log(`  ${period}: no null rows in DB, skip`);
      continue;
    }
    console.log(`\n  Period ${period} (type=${periodType}):`);

    for (const chainId of chains) {
      process.stdout.write(`    Chain ${chainId}: fetching...`);
      const traders = await fetchAllTradersForPeriodAndChain(periodType, chainId);
      console.log(`    Chain ${chainId}: ${traders.size} traders fetched`);

      // Count how many null WR addresses we found
      let found = 0;
      for (const [trunc, data] of traders) {
        if (nullIds.has(trunc)) {
          found++;
          // Merge into bigMap (period-specific key)
          const key = `${trunc}|${period}`;
          if (!bigMap.has(key)) {
            bigMap.set(key, data);
          }
        }
      }
      // Also store without period key as fallback
      for (const [trunc, data] of traders) {
        if (!bigMap.has(trunc)) bigMap.set(trunc, data);
      }
      console.log(`    -> ${found} of our null-WR addresses found in this batch`);

      await sleep(500);
    }
  }

  console.log(`\n  Total unique addresses in API map: ${bigMap.size}`);

  // Step 3: Match and update
  console.log('\n[3] Matching and updating...');
  let matched = 0, updated = 0, alreadyFilled = 0, noData = 0;

  for (const row of allRows) {
    // Try period-specific key first, then fallback to address only
    const seasonMap = { '7D': '7D', '30D': '30D', '90D': '90D' };
    const key1 = `${row.source_trader_id}|${row.season_id}`;
    const key2 = row.source_trader_id;
    const data = bigMap.get(key1) || bigMap.get(key2);

    if (!data) { noData++; continue; }
    matched++;

    const updates = {};
    if (row.win_rate == null && data.winRate != null && !isNaN(data.winRate)) {
      updates.win_rate = data.winRate;
    }
    if (row.max_drawdown == null && data.mdd != null) {
      updates.max_drawdown = data.mdd;
    }
    if (row.trades_count == null && data.tx != null) {
      updates.trades_count = data.tx;
    }

    if (Object.keys(updates).length === 0) { alreadyFilled++; continue; }

    if (DRY_RUN) {
      if (updated < 5) console.log(`  [DRY] id=${row.id} addr=${row.source_trader_id}:`, updates);
      updated++;
    } else {
      const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id);
      if (!error) {
        updated++;
        if (updated <= 5 || updated % 100 === 0) {
          console.log(`  [${updated}] Updated id=${row.id} addr=${row.source_trader_id} wr=${updates.win_rate ?? 'skip'}`);
        }
      } else {
        console.error(`  ERROR updating id=${row.id}:`, error.message);
      }
    }
  }

  // Step 4: Summary
  console.log('\n' + '='.repeat(60));
  console.log(`RESULTS:`);
  console.log(`  Total null WR rows: ${allRows.length}`);
  console.log(`  Matched in API:     ${matched}`);
  console.log(`  Updated:            ${updated}`);
  console.log(`  Already filled:     ${alreadyFilled}`);
  console.log(`  Not found in API:   ${noData}`);

  // Verify
  if (!DRY_RUN) {
    const { count: wrNull } = await sb
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', 'okx_web3')
      .is('win_rate', null);
    console.log(`\n  Remaining null WR in DB: ${wrNull}`);
  }

  if (noData > 0) {
    console.log(`\n[!] ${noData} traders not found in current API results.`);
    console.log('    These traders have dropped off the OKX leaderboard.');
    console.log('    Consider Playwright-based approach to search by address.');
  }
  console.log('='.repeat(60));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
