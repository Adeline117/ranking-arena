/**
 * Phase 2: Gains API enrichment + cleanup
 * Fetch win_rate from Gains API. Delete rows where API returns 0 trades.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CHAIN_ID = 42161;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchStats(addr) {
  try {
    const r = await fetch(
      `https://backend-global.gains.trade/api/personal-trading-history/${addr}/stats?chainId=${CHAIN_ID}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function main() {
  // Get all null WR gains rows
  let nullRows = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id')
      .eq('source', 'gains').is('win_rate', null)
      .range(from, from + 999);
    if (!data?.length) break;
    nullRows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`Gains: ${nullRows.length} null WR rows`);

  // Group by address
  const byAddr = new Map();
  for (const r of nullRows) {
    if (!byAddr.has(r.source_trader_id)) byAddr.set(r.source_trader_id, []);
    byAddr.get(r.source_trader_id).push(r);
  }

  const addresses = [...byAddr.keys()];
  console.log(`Unique addresses: ${addresses.length}`);

  let updated = 0, deleted = 0, failed = 0, noData = 0;

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    const rows = byAddr.get(addr);

    const stats = await fetchStats(addr);
    
    if (i % 50 === 0) console.log(`Progress: ${i}/${addresses.length} | updated=${updated} deleted=${deleted} failed=${failed}`);

    if (!stats || stats.error) {
      failed++;
      await sleep(300);
      continue;
    }

    const totalTrades = parseInt(stats.totalTrades || stats.total_trades || '0');
    const winRate = parseFloat(stats.winRate || stats.win_rate || '0');

    if (totalTrades === 0) {
      // Dead data - delete
      const ids = rows.map(r => r.id);
      const { error } = await supabase.from('leaderboard_ranks').delete().in('id', ids);
      if (!error) deleted += ids.length;
      else console.error(`Delete error for ${addr}:`, error.message);
      await sleep(200);
      continue;
    }

    const updateObj = {};
    if (!isNaN(winRate) && winRate > 0) updateObj.win_rate = Math.round(winRate * 100) / 100;
    if (totalTrades > 0) updateObj.trades_count = totalTrades;

    if (Object.keys(updateObj).length > 0) {
      const ids = rows.map(r => r.id);
      const { error } = await supabase.from('leaderboard_ranks').update(updateObj).in('id', ids);
      if (!error) updated += ids.length;
      else console.error(`Update error for ${addr}:`, error.message);
    } else {
      noData++;
    }

    await sleep(200);
  }

  console.log(`\nGains done: updated=${updated}, deleted=${deleted}, failed=${failed}, noData=${noData}`);
}

main().catch(console.error);
