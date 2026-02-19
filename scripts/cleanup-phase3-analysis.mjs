/**
 * Phase 3: Analyze remaining null WR rows
 * For each source, check if the same trader has win_rate in OTHER rows of leaderboard_ranks
 * If yes, backfill. If no, these are truly unenrichable.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const sources = ['gains', 'gateio', 'dydx', 'aevo', 'phemex', 'bitfinex', 'bitget_futures'];

  for (const src of sources) {
    // Get all null WR rows
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

    // Check if any of these traders have win_rate in other leaderboard_ranks rows
    let selfBackfillMap = new Map();
    for (let i = 0; i < uniqueIds.length; i += 50) {
      const batch = uniqueIds.slice(i, i + 50);
      const { data } = await supabase
        .from('leaderboard_ranks')
        .select('source_trader_id, season_id, win_rate, trades_count')
        .eq('source', src)
        .in('source_trader_id', batch)
        .not('win_rate', 'is', null);
      if (data) {
        for (const d of data) {
          if (!selfBackfillMap.has(d.source_trader_id)) {
            selfBackfillMap.set(d.source_trader_id, {
              win_rate: d.win_rate,
              trades_count: d.trades_count
            });
          }
        }
      }
    }

    let canBackfill = 0;
    for (const row of nullRows) {
      if (selfBackfillMap.has(row.source_trader_id)) canBackfill++;
    }

    console.log(`${src}: ${nullRows.length} null rows, ${uniqueIds.length} unique traders`);
    console.log(`  Can backfill from own LR rows: ${canBackfill} (${selfBackfillMap.size} traders)`);
    console.log(`  Truly dead (no WR anywhere): ${nullRows.length - canBackfill}`);
    console.log();
  }
}

main().catch(console.error);
