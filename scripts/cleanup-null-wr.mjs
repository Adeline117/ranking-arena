/**
 * Cleanup & backfill null win_rate records in leaderboard_ranks
 * 
 * Step 1: DELETE phemex (60) - platform delisted
 * Step 2: Backfill hyperliquid (40), bybit (20), binance_futures (6) via APIs
 * Step 3: DELETE any that API confirms don't exist
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function query(sql, params) {
  const res = await pool.query(sql, params);
  return res;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ STEP 1: Delete phemex null WR records ============
async function deletePhemex() {
  const count = await query(
    `SELECT count(*) FROM leaderboard_ranks WHERE source='phemex' AND win_rate IS NULL`
  );
  const n = parseInt(count.rows[0].count);
  console.log(`[phemex] Found ${n} null WR records`);
  if (n > 100) { console.log('  SKIP: count too high, unexpected'); return; }
  
  const res = await query(
    `DELETE FROM leaderboard_ranks WHERE source='phemex' AND win_rate IS NULL`
  );
  console.log(`[phemex] Deleted ${res.rowCount} records`);
}

// ============ STEP 2: Backfill Hyperliquid ============
async function backfillHyperliquid() {
  const rows = (await query(
    `SELECT id, source_trader_id, season_id FROM leaderboard_ranks WHERE source='hyperliquid' AND win_rate IS NULL`
  )).rows;
  console.log(`\n[hyperliquid] Found ${rows.length} null WR records to backfill`);
  
  let filled = 0, deleted = 0, failed = 0;
  
  for (const row of rows) {
    const addr = row.source_trader_id;
    try {
      // Get user fills to compute win rate
      const resp = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'userFills', user: addr }),
      });
      
      if (!resp.ok) {
        console.log(`  ${addr}: HTTP ${resp.status}`);
        failed++;
        await sleep(2000);
        continue;
      }
      
      const fills = await resp.json();
      
      if (!Array.isArray(fills) || fills.length === 0) {
        // No trades at all - delete
        await query(`DELETE FROM leaderboard_ranks WHERE id=$1`, [row.id]);
        deleted++;
        console.log(`  ${addr}: 0 fills → deleted`);
        await sleep(2000);
        continue;
      }

      // Group fills by trade (closedPnl != "0.0" means a closing fill)
      let wins = 0, losses = 0;
      for (const fill of fills) {
        const pnl = parseFloat(fill.closedPnl || '0');
        if (pnl === 0) continue; // opening fill
        if (pnl > 0) wins++;
        else losses++;
      }
      
      const total = wins + losses;
      if (total === 0) {
        // Only opening fills, no completed trades
        console.log(`  ${addr}: ${fills.length} fills but 0 completed trades, skip`);
        failed++;
        await sleep(2000);
        continue;
      }
      
      const winRate = (wins / total) * 100;
      await query(
        `UPDATE leaderboard_ranks SET win_rate=$1, trades_count=COALESCE(trades_count,$2) WHERE id=$3`,
        [winRate.toFixed(2), total, row.id]
      );
      filled++;
      console.log(`  ${addr}: ${wins}/${total} = ${winRate.toFixed(1)}% WR`);
      
    } catch (err) {
      console.log(`  ${addr}: ERROR ${err.message}`);
      failed++;
    }
    await sleep(2000);
  }
  
  console.log(`[hyperliquid] Done: filled=${filled}, deleted=${deleted}, failed=${failed}`);
}

// ============ STEP 3: Backfill Bybit ============
async function backfillBybit() {
  const rows = (await query(
    `SELECT id, source_trader_id, season_id FROM leaderboard_ranks WHERE source='bybit' AND win_rate IS NULL`
  )).rows;
  console.log(`\n[bybit] Found ${rows.length} null WR records to backfill`);
  
  let filled = 0, deleted = 0, failed = 0;
  
  for (const row of rows) {
    const leaderMark = row.source_trader_id;
    try {
      // Try 30d performance first
      const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader/performance?leaderMark=${leaderMark}&periodType=30`;
      const resp = await fetch(url, {
        headers: {
          'Referer': 'https://www.bybit.com/copyTrading/traderRanking',
          'Origin': 'https://www.bybit.com',
        },
      });
      
      const data = await resp.json();
      
      if (!data?.result || data.retCode !== 0) {
        // Trader doesn't exist
        await query(`DELETE FROM leaderboard_ranks WHERE id=$1`, [row.id]);
        deleted++;
        console.log(`  ${leaderMark}: not found → deleted`);
        await sleep(3000);
        continue;
      }
      
      const winRate = parseFloat(data.result.winRate);
      if (isNaN(winRate)) {
        console.log(`  ${leaderMark}: winRate is null/NaN in response`);
        failed++;
        await sleep(3000);
        continue;
      }
      
      const updates = {
        win_rate: (winRate * 100).toFixed(2),
        max_drawdown: data.result.maxDrawdown ? parseFloat(data.result.maxDrawdown) : null,
        trades_count: data.result.totalOrder ? parseInt(data.result.totalOrder) : null,
      };
      
      await query(
        `UPDATE leaderboard_ranks SET win_rate=$1, max_drawdown=COALESCE(max_drawdown,$2), trades_count=COALESCE(trades_count,$3) WHERE id=$4`,
        [updates.win_rate, updates.max_drawdown, updates.trades_count, row.id]
      );
      filled++;
      console.log(`  ${leaderMark}: WR=${updates.win_rate}%`);
      
    } catch (err) {
      console.log(`  ${leaderMark}: ERROR ${err.message}`);
      failed++;
    }
    await sleep(3000);
  }
  
  console.log(`[bybit] Done: filled=${filled}, deleted=${deleted}, failed=${failed}`);
}

// ============ STEP 4: Backfill Binance Futures ============
async function backfillBinanceFutures() {
  const rows = (await query(
    `SELECT id, source_trader_id, season_id FROM leaderboard_ranks WHERE source='binance_futures' AND win_rate IS NULL`
  )).rows;
  console.log(`\n[binance_futures] Found ${rows.length} null WR records to backfill`);
  
  let filled = 0, deleted = 0, failed = 0;
  
  for (const row of rows) {
    const portfolioId = row.source_trader_id;
    try {
      const resp = await fetch('https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://www.binance.com',
          'Referer': `https://www.binance.com/en/copy-trading/lead-details/${portfolioId}`,
        },
        body: JSON.stringify({ portfolioId, timeRange: 'MONTHLY' }),
      });
      
      const data = await resp.json();
      
      if (!data?.data) {
        // Trader doesn't exist
        await query(`DELETE FROM leaderboard_ranks WHERE id=$1`, [row.id]);
        deleted++;
        console.log(`  ${portfolioId}: not found → deleted`);
        await sleep(3000);
        continue;
      }
      
      const winRate = parseFloat(data.data.winRate);
      if (isNaN(winRate)) {
        console.log(`  ${portfolioId}: winRate null in response`);
        failed++;
        await sleep(3000);
        continue;
      }
      
      const wrPct = (winRate * 100).toFixed(2);
      const mdd = data.data.maxDrawdown ? parseFloat(data.data.maxDrawdown) : null;
      const trades = data.data.totalTrades ? parseInt(data.data.totalTrades) : null;
      
      await query(
        `UPDATE leaderboard_ranks SET win_rate=$1, max_drawdown=COALESCE(max_drawdown,$2), trades_count=COALESCE(trades_count,$3) WHERE id=$4`,
        [wrPct, mdd, trades, row.id]
      );
      filled++;
      console.log(`  ${portfolioId}: WR=${wrPct}%`);
      
    } catch (err) {
      console.log(`  ${portfolioId}: ERROR ${err.message}`);
      failed++;
    }
    await sleep(3000);
  }
  
  console.log(`[binance_futures] Done: filled=${filled}, deleted=${deleted}, failed=${failed}`);
}

// ============ MAIN ============
async function main() {
  console.log('=== Cleanup null win_rate records ===\n');
  
  // Pre-check
  const preCheck = (await query(
    `SELECT source, count(*) as n FROM leaderboard_ranks WHERE win_rate IS NULL AND source IN ('phemex','hyperliquid','bybit','binance_futures') GROUP BY source ORDER BY source`
  )).rows;
  console.log('Pre-check counts:');
  preCheck.forEach(r => console.log(`  ${r.source}: ${r.n}`));
  
  // Step 1: Delete phemex
  await deletePhemex();
  
  // Step 2-4: Backfill
  await backfillHyperliquid();
  await backfillBybit();
  await backfillBinanceFutures();
  
  // Post-check
  console.log('\n=== Post-check ===');
  const postCheck = (await query(
    `SELECT source, count(*) as n FROM leaderboard_ranks WHERE win_rate IS NULL AND source IN ('phemex','hyperliquid','bybit','binance_futures') GROUP BY source ORDER BY source`
  )).rows;
  if (postCheck.length === 0) {
    console.log('All target sources: 0 null WR records! ✅');
  } else {
    postCheck.forEach(r => console.log(`  ${r.source}: ${r.n} remaining`));
  }
  
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
