#!/usr/bin/env node
/**
 * Enrich dYdX leaderboard_ranks with win_rate calculated from on-chain fills.
 * Must run from VPS (dYdX geo-blocks US IPs).
 * 
 * Logic:
 * 1. Fetch all dydx rows with win_rate=null from Supabase
 * 2. For each unique trader address, fetch ALL fills from indexer
 * 3. Group fills by market, build position round-trips
 * 4. A "trade" = position going from 0 to non-zero back to 0 (or flip)
 * 5. Win = realized PnL > 0 for that round-trip
 * 6. Update leaderboard_ranks rows with computed win_rate + trades_count
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INDEXER = 'https://indexer.dydx.trade';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAllFills(address) {
  const allFills = [];
  let page = 0;
  const limit = 100;
  
  while (true) {
    const url = `${INDEXER}/v4/fills?address=${address}&subaccountNumber=0&limit=${limit}${page > 0 ? `&page=${page}` : ''}`;
    
    let resp;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (r.status === 429) {
          console.log(`  Rate limited, waiting 10s...`);
          await sleep(10000);
          continue;
        }
        if (!r.ok) {
          // Try createdBeforeOrAt pagination
          break;
        }
        resp = await r.json();
        break;
      } catch (e) {
        console.log(`  Fetch error (retry ${retry}): ${e.message}`);
        await sleep(3000);
      }
    }
    
    if (!resp?.fills?.length) break;
    allFills.push(...resp.fills);
    
    if (resp.fills.length < limit) break;
    
    // Use createdBeforeOrAt for pagination
    const oldest = resp.fills[resp.fills.length - 1];
    const nextUrl = `${INDEXER}/v4/fills?address=${address}&subaccountNumber=0&limit=${limit}&createdBeforeOrAt=${oldest.createdAt}&createdBeforeOrAtHeight=${Number(oldest.createdAtHeight) - 1}`;
    
    let resp2;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const r = await fetch(nextUrl, { signal: AbortSignal.timeout(15000) });
        if (r.status === 429) { await sleep(10000); continue; }
        if (!r.ok) break;
        resp2 = await r.json();
        break;
      } catch (e) {
        await sleep(3000);
      }
    }
    
    if (!resp2?.fills?.length) break;
    allFills.push(...resp2.fills);
    
    if (resp2.fills.length < limit) break;
    
    // Continue pagination
    page++;
    if (allFills.length > 5000) {
      console.log(`  Capped at ${allFills.length} fills`);
      break;
    }
    await sleep(500);
  }
  
  return allFills;
}

// Better pagination: just use createdBeforeOrAt cursor
async function fetchAllFillsCursor(address) {
  const allFills = [];
  let cursor = null;
  const limit = 100;
  
  while (true) {
    let url = `${INDEXER}/v4/fills?address=${address}&subaccountNumber=0&limit=${limit}`;
    if (cursor) url += `&createdBeforeOrAtHeight=${cursor}`;
    
    let resp;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (r.status === 429) { await sleep(10000); continue; }
        if (r.status === 404) return allFills;
        if (!r.ok) { console.log(`  HTTP ${r.status}`); return allFills; }
        resp = await r.json();
        break;
      } catch (e) {
        if (retry === 2) return allFills;
        await sleep(3000);
      }
    }
    
    if (!resp?.fills?.length) break;
    allFills.push(...resp.fills);
    
    if (resp.fills.length < limit) break;
    
    const oldest = resp.fills[resp.fills.length - 1];
    const newCursor = Number(oldest.createdAtHeight) - 1;
    if (cursor && newCursor >= cursor) break; // no progress
    cursor = newCursor;
    
    if (allFills.length > 10000) {
      console.log(`  Capped at ${allFills.length} fills`);
      break;
    }
    await sleep(300);
  }
  
  return allFills;
}

/**
 * Calculate win_rate from fills by grouping into position round-trips per market.
 * Returns { win_rate, trades_count } or null if insufficient data.
 */
function calculateWinRate(fills) {
  if (!fills.length) return null;
  
  // Sort fills by time ascending
  fills.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  
  // Group by market
  const byMarket = {};
  for (const f of fills) {
    if (!byMarket[f.market]) byMarket[f.market] = [];
    byMarket[f.market].push(f);
  }
  
  let wins = 0;
  let losses = 0;
  
  for (const [market, marketFills] of Object.entries(byMarket)) {
    // Track position and cost basis
    let pos = 0; // positive = long, negative = short
    let costBasis = 0; // total cost of current position
    let realizedPnl = 0;
    
    for (const fill of marketFills) {
      const size = Number(fill.size);
      const price = Number(fill.price);
      const side = fill.side; // BUY or SELL
      const signedSize = side === 'BUY' ? size : -size;
      
      const prevPos = pos;
      const newPos = pos + signedSize;
      
      if (prevPos === 0) {
        // Opening new position
        pos = newPos;
        costBasis = price * Math.abs(newPos);
      } else if (Math.sign(prevPos) === Math.sign(newPos) || newPos === 0) {
        if (Math.abs(newPos) > Math.abs(prevPos)) {
          // Adding to position
          costBasis += price * Math.abs(signedSize);
          pos = newPos;
        } else {
          // Reducing or closing position
          const avgEntry = costBasis / Math.abs(prevPos);
          const closedSize = Math.abs(signedSize);
          
          if (prevPos > 0) {
            // Was long, selling to close
            realizedPnl += (price - avgEntry) * closedSize;
          } else {
            // Was short, buying to close
            realizedPnl += (avgEntry - price) * closedSize;
          }
          
          if (Math.abs(newPos) < 0.0000001) {
            // Position closed - record trade result
            if (realizedPnl > 0) wins++;
            else losses++;
            realizedPnl = 0;
            pos = 0;
            costBasis = 0;
          } else {
            costBasis = avgEntry * Math.abs(newPos);
            pos = newPos;
          }
        }
      } else {
        // Position flip - close current, open opposite
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
        
        // Open new position in opposite direction
        pos = newPos;
        costBasis = price * Math.abs(newPos);
      }
    }
  }
  
  const totalTrades = wins + losses;
  if (totalTrades < 2) return null; // Need at least 2 completed round-trips
  
  return {
    win_rate: Number((wins / totalTrades * 100).toFixed(2)),
    trades_count: totalTrades,
  };
}

async function main() {
  console.log('Fetching dydx rows with null win_rate...');
  
  // Get all affected rows
  const { data: rows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id,source_trader_id,season_id')
    .eq('source', 'dydx')
    .is('win_rate', null);
  
  if (error) { console.error('DB error:', error); process.exit(1); }
  console.log(`Found ${rows.length} rows to enrich`);
  
  // Group by trader
  const byTrader = {};
  for (const r of rows) {
    if (!byTrader[r.source_trader_id]) byTrader[r.source_trader_id] = [];
    byTrader[r.source_trader_id].push(r);
  }
  
  const traders = Object.keys(byTrader);
  console.log(`${traders.length} unique traders to process`);
  
  let updated = 0, skipped = 0, failed = 0;
  
  for (let i = 0; i < traders.length; i++) {
    const addr = traders[i];
    const traderRows = byTrader[addr];
    
    process.stdout.write(`[${i+1}/${traders.length}] ${addr.slice(0,12)}... `);
    
    try {
      const fills = await fetchAllFillsCursor(addr);
      process.stdout.write(`${fills.length} fills -> `);
      
      const result = calculateWinRate(fills);
      
      if (!result) {
        console.log('skip (insufficient trades)');
        skipped += traderRows.length;
        continue;
      }
      
      console.log(`WR=${result.win_rate}% (${result.trades_count} trades)`);
      
      // Update all rows for this trader
      const ids = traderRows.map(r => r.id);
      const { error: upErr } = await supabase
        .from('leaderboard_ranks')
        .update({ win_rate: result.win_rate, trades_count: result.trades_count })
        .in('id', ids);
      
      if (upErr) {
        console.error(`  Update error: ${upErr.message}`);
        failed += traderRows.length;
      } else {
        updated += traderRows.length;
      }
      
      await sleep(500); // Rate limit
    } catch (e) {
      console.log(`error: ${e.message}`);
      failed += traderRows.length;
    }
  }
  
  console.log(`\nDone! Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed}`);
}

main().catch(console.error);
