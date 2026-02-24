/**
 * Gains Network win_rate enrichment (local Mac Mini)
 * Fetches from backend-global.gains.trade personal stats API
 * Updates win_rate + trades_count for all gains snapshots with null win_rate
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createClient } = require('@supabase/supabase-js');
const { config } = require('dotenv');
config({ path: new URL('../../.env.local', import.meta.url).pathname });

const supabase = createClient(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CHAIN_ID = 42161;
const DELAY = 300;
const CONCURRENCY = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchStats(addr) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(
        `https://backend-global.gains.trade/api/personal-trading-history/${addr}/stats?chainId=${CHAIN_ID}`,
        { signal: ctrl.signal }
      );
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

async function main() {
  // Get all gains snapshots with null win_rate, grouped by address
  let allSnaps = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id, win_rate, trades_count')
      .eq('source', 'gains')
      .is('win_rate', null)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) { console.error('Query error:', error.message); break; }
    if (!data?.length) break;
    allSnaps = allSnaps.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  // Group by address
  const byAddr = {};
  for (const s of allSnaps) {
    const a = s.source_trader_id;
    if (!byAddr[a]) byAddr[a] = [];
    byAddr[a].push(s);
  }

  const addresses = Object.keys(byAddr);
  console.log(`${allSnaps.length} snapshots with null win_rate across ${addresses.length} unique addresses`);

  let updated = 0, failed = 0, noData = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < addresses.length; i += CONCURRENCY) {
    const batch = addresses.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (addr) => {
      const stats = await fetchStats(addr);
      if (!stats || stats.error) return { addr, ok: false };

      const winRateRaw = parseFloat(stats.winRate);
      const totalTrades = parseInt(stats.totalTrades);
      
      if (isNaN(winRateRaw) && isNaN(totalTrades)) return { addr, ok: false, nodata: true };

      const updateData = {};
      if (!isNaN(winRateRaw)) updateData.win_rate = Math.round(winRateRaw * 10000) / 100; // 0.5433 → 54.33
      if (!isNaN(totalTrades)) updateData.trades_count = totalTrades;

      if (Object.keys(updateData).length === 0) return { addr, ok: false, nodata: true };

      // If winRate is 0 and totalTrades is 0, this address has no real data
      if (updateData.win_rate === 0 && updateData.trades_count === 0) return { addr, ok: false, nodata: true };

      const ids = byAddr[addr].map(s => s.id);
      const { error } = await supabase.from('trader_snapshots').update(updateData).in('id', ids);
      if (error) return { addr, ok: false, err: error.message };
      return { addr, ok: true, count: ids.length };
    }));

    for (const r of results) {
      if (r.ok) updated += r.count;
      else if (r.nodata) noData++;
      else failed++;
    }

    if ((i + CONCURRENCY) % 60 === 0 || i + CONCURRENCY >= addresses.length) {
      console.log(`${Math.min(i + CONCURRENCY, addresses.length)}/${addresses.length} | updated: ${updated} | noData: ${noData} | failed: ${failed}`);
    }
    await sleep(DELAY);
  }

  console.log(`\n✅ Done! Updated ${updated} snapshots, No data: ${noData}, Failed: ${failed}`);

  // Verify
  const { count } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'gains').is('win_rate', null);
  console.log(`Remaining null win_rate: ${count}`);
}

main().catch(e => { console.error(e); process.exit(1); });
