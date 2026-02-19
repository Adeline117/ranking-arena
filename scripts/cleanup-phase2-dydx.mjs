/**
 * Phase 2: dYdX enrichment from indexer fills
 * Fetch fills, compute win_rate from round-trip trades.
 * Delete traders with 0 fills.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const INDEXER = 'https://indexer.dydx.trade';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAllFills(address) {
  const allFills = [];
  let createdBefore = null;
  
  for (let page = 0; page < 50; page++) {
    let url = `${INDEXER}/v4/fills?address=${address}&subaccountNumber=0&limit=100`;
    if (createdBefore) url += `&createdBeforeOrAt=${createdBefore}`;
    
    let resp;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (r.status === 429) { await sleep(10000); continue; }
        if (r.status === 404 || !r.ok) return allFills;
        resp = await r.json();
        break;
      } catch { await sleep(3000); }
    }
    
    if (!resp?.fills?.length) break;
    allFills.push(...resp.fills);
    if (resp.fills.length < 100) break;
    
    const oldest = resp.fills[resp.fills.length - 1];
    createdBefore = oldest.createdAt;
    await sleep(200);
  }
  
  return allFills;
}

function computeWinRate(fills) {
  if (!fills.length) return null;
  
  // Group by market, track positions
  const byMarket = {};
  for (const f of fills) {
    const m = f.market || f.ticker;
    if (!byMarket[m]) byMarket[m] = [];
    byMarket[m].push(f);
  }
  
  let wins = 0, losses = 0;
  
  for (const [market, marketFills] of Object.entries(byMarket)) {
    // Sort by time
    marketFills.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    
    let position = 0;
    let entryValue = 0;
    
    for (const fill of marketFills) {
      const size = parseFloat(fill.size);
      const price = parseFloat(fill.price);
      const side = fill.side; // BUY or SELL
      const qty = side === 'BUY' ? size : -size;
      
      const prevPos = position;
      position += qty;
      
      // Check if position crossed zero or closed
      if (prevPos !== 0 && Math.sign(position) !== Math.sign(prevPos)) {
        // Position closed or flipped
        const closingQty = Math.abs(prevPos);
        const closeValue = closingQty * price;
        const pnl = prevPos > 0 ? closeValue - entryValue : entryValue - closeValue;
        
        if (pnl > 0) wins++;
        else losses++;
        
        entryValue = Math.abs(position) * price;
      } else if (Math.sign(qty) === Math.sign(prevPos) || prevPos === 0) {
        entryValue += Math.abs(qty) * price;
      }
    }
  }
  
  const total = wins + losses;
  if (total === 0) return null;
  return { win_rate: Math.round((wins / total) * 10000) / 100, trades_count: total };
}

async function main() {
  let nullRows = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id')
      .eq('source', 'dydx').is('win_rate', null)
      .range(from, from + 999);
    if (!data?.length) break;
    nullRows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`dYdX: ${nullRows.length} null WR rows`);

  const byAddr = new Map();
  for (const r of nullRows) {
    if (!byAddr.has(r.source_trader_id)) byAddr.set(r.source_trader_id, []);
    byAddr.get(r.source_trader_id).push(r);
  }

  const addresses = [...byAddr.keys()];
  console.log(`Unique addresses: ${addresses.length}`);

  let updated = 0, deleted = 0, failed = 0;

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    const rows = byAddr.get(addr);

    if (i % 20 === 0) console.log(`Progress: ${i}/${addresses.length} | updated=${updated} deleted=${deleted} failed=${failed}`);

    const fills = await fetchAllFills(addr);
    
    if (fills.length === 0) {
      // No fills - delete
      const ids = rows.map(r => r.id);
      const { error } = await supabase.from('leaderboard_ranks').delete().in('id', ids);
      if (!error) deleted += ids.length;
      await sleep(300);
      continue;
    }

    const result = computeWinRate(fills);
    
    if (!result) {
      failed++;
      await sleep(300);
      continue;
    }

    const ids = rows.map(r => r.id);
    const { error } = await supabase.from('leaderboard_ranks').update({
      win_rate: result.win_rate,
      trades_count: result.trades_count
    }).in('id', ids);
    
    if (!error) updated += ids.length;
    else console.error(`Update error for ${addr}:`, error.message);
    
    await sleep(300);
  }

  console.log(`\ndYdX done: updated=${updated}, deleted=${deleted}, failed=${failed}`);
}

main().catch(console.error);
