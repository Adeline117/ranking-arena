/**
 * Phase 1: Cross-season backfill from trader_snapshots
 * For traders that have win_rate in one season but not another,
 * use the available win_rate to fill the nulls.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const sources = ['gains', 'gateio', 'dydx', 'aevo', 'phemex', 'bitfinex', 'bitget_futures'];
  let totalUpdated = 0;

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
    if (!uniqueIds.length) continue;

    // Get snapshot data for these traders (any season with win_rate)
    let snapshotData = new Map(); // trader_id -> { win_rate, trades_count }
    for (let i = 0; i < uniqueIds.length; i += 50) {
      const batch = uniqueIds.slice(i, i + 50);
      const { data: snaps } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, win_rate, trades_count')
        .eq('source', src)
        .in('source_trader_id', batch)
        .not('win_rate', 'is', null)
        .order('captured_at', { ascending: false })
        .limit(500);
      if (snaps) {
        for (const s of snaps) {
          if (!snapshotData.has(s.source_trader_id)) {
            snapshotData.set(s.source_trader_id, {
              win_rate: s.win_rate,
              trades_count: s.trades_count
            });
          }
        }
      }
    }

    if (!snapshotData.size) {
      console.log(`${src}: no snapshot data available, skipping`);
      continue;
    }

    // Update matching rows
    let updated = 0;
    for (const row of nullRows) {
      const data = snapshotData.get(row.source_trader_id);
      if (!data) continue;

      const updateObj = {};
      if (data.win_rate != null) updateObj.win_rate = data.win_rate;
      if (data.trades_count != null) updateObj.trades_count = data.trades_count;
      if (!Object.keys(updateObj).length) continue;

      const { error } = await supabase
        .from('leaderboard_ranks')
        .update(updateObj)
        .eq('id', row.id);
      if (!error) updated++;
    }

    console.log(`${src}: backfilled ${updated} rows from snapshots (${snapshotData.size} traders had data)`);
    totalUpdated += updated;
  }

  console.log(`\nPhase 1 total: ${totalUpdated} rows backfilled`);
}

main().catch(console.error);
