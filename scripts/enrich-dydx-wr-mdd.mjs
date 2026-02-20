#!/usr/bin/env node
/**
 * dYdX WR + MDD Enrichment (SOCKS proxy via VPS)
 * 
 * - win_rate: computed from fills using position round-trip tracking
 * - max_drawdown: computed from historical PnL equity curve
 * 
 * Prerequisites: ssh -D 1080 -N -f root@45.76.152.169
 */

import { createClient } from '@supabase/supabase-js';
import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const execAsync = promisify(exec);
const INDEXER = 'https://indexer.dydx.trade/v4';
const SOCKS = 'socks5h://127.0.0.1:1080';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── API helpers ──────────────────────────────────────────────────────────────

async function curlGet(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const { stdout, stderr } = await execAsync(
        `curl -s --max-time 20 -x ${SOCKS} '${url}' -H 'User-Agent: Mozilla/5.0'`,
        { timeout: 25000 }
      );
      if (!stdout.trim()) {
        if (i < retries - 1) { await sleep(2000); continue; }
        return null;
      }
      const parsed = JSON.parse(stdout);
      if (parsed?.errors?.length && parsed.errors[0]?.code === 'GEOBLOCKED') {
        console.error('  GEOBLOCKED - is SOCKS proxy running?');
        return null;
      }
      return parsed;
    } catch (e) {
      if (i < retries - 1) { await sleep(2000 * (i + 1)); continue; }
      return null;
    }
  }
  return null;
}

// ── Fills fetching with cursor pagination ────────────────────────────────────

async function fetchAllFills(address) {
  const allFills = [];
  let cursor = null;
  const limit = 100;
  const maxFills = 2000; // cap: enough for meaningful WR calc, avoids deep pagination

  while (true) {
    let url = `${INDEXER}/fills?address=${address}&subaccountNumber=0&limit=${limit}`;
    if (cursor !== null) url += `&createdBeforeOrAtHeight=${cursor}`;

    const data = await curlGet(url);
    if (!data?.fills?.length) break;

    allFills.push(...data.fills);

    if (data.fills.length < limit) break;
    if (allFills.length >= maxFills) {
      // Cap hit — enough data for WR
      break;
    }

    // Cursor: go before the oldest fill in this page
    const oldest = data.fills[data.fills.length - 1];
    const newCursor = Math.max(0, Number(oldest.createdAtHeight) - 1);
    if (cursor !== null && newCursor >= cursor) break; // no progress
    cursor = newCursor;

    await sleep(200);
  }

  return allFills;
}

// ── Historical PnL with cursor pagination ───────────────────────────────────

async function fetchAllHistoricalPnl(address) {
  const all = [];
  let beforeHeight = null;
  const limit = 1000;
  const maxRecords = 2000; // ~2000 hourly snapshots ≈ 83 days, enough for MDD

  while (true) {
    let url = `${INDEXER}/historical-pnl?address=${address}&subaccountNumber=0&limit=${limit}`;
    if (beforeHeight !== null) url += `&beforeHeight=${beforeHeight}`;

    const data = await curlGet(url);
    if (!data?.historicalPnl?.length) break;

    all.push(...data.historicalPnl);

    if (data.historicalPnl.length < limit) break;
    if (all.length >= maxRecords) break;

    const oldest = data.historicalPnl[data.historicalPnl.length - 1];
    const newH = Number(oldest.blockHeight);
    if (beforeHeight !== null && newH >= beforeHeight) break;
    beforeHeight = newH;

    await sleep(300);
  }

  return all;
}

// ── Win rate calculation (round-trip tracking) ───────────────────────────────

function calculateWinRate(fills) {
  if (!fills.length) return null;

  // Sort by time ascending
  const sorted = [...fills].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Group by market
  const byMarket = {};
  for (const f of sorted) {
    if (!byMarket[f.market]) byMarket[f.market] = [];
    byMarket[f.market].push(f);
  }

  let wins = 0, losses = 0;

  for (const [, marketFills] of Object.entries(byMarket)) {
    let pos = 0;       // positive = long, negative = short
    let costBasis = 0; // total cost of current position
    let realizedPnl = 0;

    for (const fill of marketFills) {
      const size = Number(fill.size);
      const price = Number(fill.price);
      const signedSize = fill.side === 'BUY' ? size : -size;
      const prevPos = pos;
      const newPos = pos + signedSize;

      if (prevPos === 0) {
        // Opening new position
        pos = newPos;
        costBasis = price * Math.abs(newPos);
      } else if (Math.sign(prevPos) === Math.sign(newPos) || newPos === 0) {
        if (Math.abs(newPos) >= Math.abs(prevPos)) {
          // Adding to position (or same size)
          costBasis += price * Math.abs(signedSize);
          pos = newPos;
        } else {
          // Reducing position
          const avgEntry = costBasis / Math.abs(prevPos);
          const closedSize = Math.abs(signedSize);

          if (prevPos > 0) {
            realizedPnl += (price - avgEntry) * closedSize;
          } else {
            realizedPnl += (avgEntry - price) * closedSize;
          }

          if (Math.abs(newPos) < 1e-9) {
            // Position fully closed — record trade result
            if (realizedPnl > 0) wins++;
            else losses++;
            realizedPnl = 0;
            pos = 0;
            costBasis = 0;
          } else {
            // Partially closed
            costBasis = (costBasis / Math.abs(prevPos)) * Math.abs(newPos);
            pos = newPos;
          }
        }
      } else {
        // Position flip — close then reverse
        const avgEntry = costBasis / Math.abs(prevPos);
        const closedSize = Math.abs(prevPos);

        if (prevPos > 0) {
          realizedPnl += (price - avgEntry) * closedSize;
        } else {
          realizedPnl += (avgEntry - price) * closedSize;
        }

        if (realizedPnl > 0) wins++;
        else losses++;
        realizedPnl = 0;

        // Open new reversed position
        const remainingSize = size - closedSize;
        if (remainingSize > 1e-9) {
          pos = fill.side === 'BUY' ? remainingSize : -remainingSize;
          costBasis = price * Math.abs(pos);
        } else {
          pos = 0;
          costBasis = 0;
        }
      }
    }
  }

  const total = wins + losses;
  if (total < 1) return null;

  return {
    win_rate: Number((wins / total * 100).toFixed(2)),
    trades_count: total,
  };
}

// ── Max drawdown from equity curve ──────────────────────────────────────────

function calculateMDD(pnlHistory) {
  if (pnlHistory.length < 2) return null;

  // Sort oldest first (ascending by blockHeight)
  const sorted = [...pnlHistory].sort((a, b) => Number(a.blockHeight) - Number(b.blockHeight));
  const equities = sorted.map(p => parseFloat(p.equity));

  let peak = equities[0];
  let maxDD = 0;

  for (const eq of equities) {
    if (eq > peak) peak = eq;
    if (peak > 0) {
      const dd = (peak - eq) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }

  // Return as percentage, 2 decimal places; null if trivially small
  return maxDD > 0.001 ? Number((maxDD * 100).toFixed(2)) : null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 dYdX WR + MDD Enrichment (SOCKS proxy)\n');

  // Verify SOCKS proxy by testing a known address
  const testData = await curlGet(`${INDEXER}/fills?address=dydx1jkgkrxjj2l2ld4dchflkvhxegfxlrvhe3uyvtz&subaccountNumber=0&limit=1`);
  if (testData === null) {
    console.error('❌ Cannot reach dYdX API via SOCKS proxy!');
    console.error('   Run: ssh -D 1080 -N -f root@45.76.152.169');
    process.exit(1);
  }
  console.log('✅ SOCKS proxy OK\n');

  // --- Fetch all dydx rows needing WR or MDD ---
  console.log('Fetching rows with null win_rate or null max_drawdown...');
  let allRows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'dydx')
      .or('win_rate.is.null,max_drawdown.is.null')
      .range(offset, offset + 999);
    if (error) { console.error('DB error:', error.message); break; }
    if (!data?.length) break;
    allRows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  console.log(`Found ${allRows.length} rows (leaderboard_ranks, dydx, wr_null OR mdd_null)`);

  // --- Group by trader ---
  const byTrader = new Map();
  for (const row of allRows) {
    if (!byTrader.has(row.source_trader_id)) byTrader.set(row.source_trader_id, []);
    byTrader.get(row.source_trader_id).push(row);
  }
  const traders = [...byTrader.keys()];
  console.log(`Unique traders: ${traders.length}\n`);

  let updatedWR = 0, updatedMDD = 0, skipped = 0, failed = 0;

  for (let i = 0; i < traders.length; i++) {
    const addr = traders[i];
    const rows = byTrader.get(addr);

    // Determine what we need for this trader
    const needsWR  = rows.some(r => r.win_rate == null);
    const needsMDD = rows.some(r => r.max_drawdown == null);

    process.stdout.write(`[${i+1}/${traders.length}] ${addr.slice(0, 20)}...`);

    let winRateResult = null;
    let mdd = null;

    try {
      // --- Win rate (fills) ---
      if (needsWR) {
        const fills = await fetchAllFills(addr);
        if (fills.length > 0) {
          winRateResult = calculateWinRate(fills);
        }
        process.stdout.write(` fills=${fills.length}`);
        await sleep(200);
      }

      // --- Max drawdown (historical PnL) ---
      if (needsMDD) {
        const pnlHistory = await fetchAllHistoricalPnl(addr);
        if (pnlHistory.length > 0) {
          mdd = calculateMDD(pnlHistory);
        }
        process.stdout.write(` pnl=${pnlHistory.length}`);
        await sleep(200);
      }

      // --- Update rows ---
      let anyUpdate = false;
      for (const row of rows) {
        const updates = {};

        if (row.win_rate == null && winRateResult) {
          updates.win_rate = winRateResult.win_rate;
          if (row.trades_count == null) updates.trades_count = winRateResult.trades_count;
        }
        if (row.max_drawdown == null && mdd !== null) {
          updates.max_drawdown = mdd;
        }

        if (Object.keys(updates).length > 0) {
          const { error: upErr } = await sb
            .from('leaderboard_ranks')
            .update(updates)
            .eq('id', row.id);
          if (upErr) {
            console.log(`\n  DB update error: ${upErr.message}`);
            failed++;
          } else {
            if (updates.win_rate !== undefined) updatedWR++;
            if (updates.max_drawdown !== undefined) updatedMDD++;
            anyUpdate = true;
          }
        }
      }

      if (anyUpdate) {
        const wl = winRateResult ? `WR=${winRateResult.win_rate}%(${winRateResult.trades_count})` : '';
        const ml = mdd !== null ? `MDD=${mdd}%` : '';
        console.log(` → ${[wl, ml].filter(Boolean).join(' ')}`);
      } else {
        console.log(' → skip (no data)');
        skipped++;
      }

    } catch (e) {
      console.log(` → error: ${e.message}`);
      failed++;
    }

    // Brief rate-limit pause every 10 traders
    if ((i + 1) % 10 === 0) {
      console.log(`  [progress] wr+=${updatedWR} mdd+=${updatedMDD} skip=${skipped} fail=${failed}`);
      await sleep(1000);
    }
  }

  // --- Final verification ---
  console.log('\n──────────────────────────────────────────');
  console.log(`📊 Run complete: WR updated=${updatedWR}, MDD updated=${updatedMDD}, skipped=${skipped}, failed=${failed}`);

  const { count: total }  = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'dydx');
  const { count: wrNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'dydx').is('win_rate', null);
  const { count: mddNull }= await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'dydx').is('max_drawdown', null);
  console.log(`\nleaderboard_ranks dydx: total=${total} | wr_null=${wrNull} | mdd_null=${mddNull}`);
}

main().catch(e => { console.error(e); process.exit(1); });
