/**
 * Phase 3: Self-backfill from leaderboard_ranks
 * For traders that have win_rate in one season but not another within LR itself.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const sources = ['gains', 'gateio', 'dydx', 'aevo', 'phemex', 'bitfinex', 'bitget_futures'];
  let grandTotal = 0;

  for (const src of sources) {
    let nullRows = [];
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from('leaderboard_ranks')
        .select('id, source_trader_id, season_id')
        .eq('source', src).is('win_rate', null)
        .range(from, from + 999);
      if (!data?.length) break;
      nullRows.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }

    const uniqueIds = [...new Set(nullRows.map(r => r.source_trader_id))];
    if (!uniqueIds.length) continue;

    // Get win_rate from other rows for same traders
    let dataMap = new Map();
    for (let i = 0; i < uniqueIds.length; i += 50) {
      const batch = uniqueIds.slice(i, i + 50);
      const { data } = await supabase
        .from('leaderboard_ranks')
        .select('source_trader_id, win_rate, trades_count, max_drawdown')
        .eq('source', src)
        .in('source_trader_id', batch)
        .not('win_rate', 'is', null)
        .limit(500);
      if (data) {
        for (const d of data) {
          if (!dataMap.has(d.source_trader_id)) {
            dataMap.set(d.source_trader_id, {
              win_rate: d.win_rate,
              trades_count: d.trades_count,
              max_drawdown: d.max_drawdown
            });
          }
        }
      }
    }

    if (!dataMap.size) {
      console.log(`${src}: no self-backfill data`);
      continue;
    }

    let updated = 0;
    for (const row of nullRows) {
      const data = dataMap.get(row.source_trader_id);
      if (!data) continue;

      const updateObj = {};
      if (data.win_rate != null) updateObj.win_rate = data.win_rate;
      if (data.trades_count != null) updateObj.trades_count = data.trades_count;
      if (data.max_drawdown != null) updateObj.max_drawdown = data.max_drawdown;
      if (!Object.keys(updateObj).length) continue;

      const { error } = await supabase
        .from('leaderboard_ranks')
        .update(updateObj)
        .eq('id', row.id);
      if (!error) updated++;
    }

    console.log(`${src}: self-backfilled ${updated} rows`);
    grandTotal += updated;
  }

  console.log(`\nTotal self-backfilled: ${grandTotal}`);
}

main().catch(console.error);
