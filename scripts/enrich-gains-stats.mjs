import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CHAIN_ID = 42161;
const DELAY = 200;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return res.json();
  } catch { clearTimeout(timer); return null; }
}

async function main() {
  // Paginate all gains snapshots
  let traders = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id, win_rate, trades_count, pnl')
      .eq('source', 'gains')
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (!data?.length) break;
    traders = traders.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  // Group by address
  const byAddr = {};
  for (const t of traders) {
    if (!byAddr[t.source_trader_id]) byAddr[t.source_trader_id] = [];
    byAddr[t.source_trader_id].push(t);
  }

  const addresses = Object.keys(byAddr);
  console.log(`Total: ${traders.length} snapshots, ${addresses.length} unique addresses`);

  // Filter to only those needing update
  const needUpdate = addresses.filter(a => byAddr[a].some(s => s.win_rate === null || s.trades_count === null));
  console.log(`Need update: ${needUpdate.length} addresses`);

  let updated = 0, failed = 0, apiCalls = 0;

  for (let i = 0; i < needUpdate.length; i++) {
    const addr = needUpdate[i];
    const snapshots = byAddr[addr];
    
    const stats = await fetchWithTimeout(
      `https://backend-global.gains.trade/api/personal-trading-history/${addr}/stats?chainId=${CHAIN_ID}`
    );
    apiCalls++;

    if (!stats || stats.error) { failed++; continue; }

    const winRate = parseFloat(stats.winRate);
    const totalTrades = stats.totalTrades;

    const updateData = {};
    if (!isNaN(winRate)) updateData.win_rate = Math.round(winRate * 100) / 100;
    if (totalTrades != null) updateData.trades_count = totalTrades;

    if (Object.keys(updateData).length === 0) { continue; }

    const ids = snapshots.filter(s => s.win_rate === null || s.trades_count === null).map(s => s.id);
    if (ids.length > 0) {
      const { error } = await supabase.from('trader_snapshots').update(updateData).in('id', ids);
      if (error) { console.error(`Err ${addr}:`, error.message); failed++; }
      else { updated += ids.length; }
    }

    if ((i + 1) % 20 === 0) console.log(`${i + 1}/${needUpdate.length} | updated: ${updated} | failed: ${failed}`);
    await sleep(DELAY);
  }

  console.log(`\nDone! Updated: ${updated}, Failed: ${failed}, API calls: ${apiCalls}`);

  // Verify
  const { count } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'gains').is('win_rate', null);
  console.log(`Remaining null win_rate: ${count}`);
}

main().catch(console.error);
