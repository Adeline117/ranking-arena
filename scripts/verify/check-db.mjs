import { createClient } from '@supabase/supabase-js';

const db = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE',
  { auth: { persistSession: false } }
);

async function main() {
  // Check if v2 tables exist
  const { data: profiles, error: e1 } = await db.from('trader_profiles').select('id').limit(1);
  const { data: snapshots, error: e2 } = await db.from('trader_snapshots_v2').select('id').limit(1);
  const { data: jobs, error: e3 } = await db.from('refresh_jobs').select('id').limit(1);

  console.log('trader_profiles:', e1 ? 'ERROR: ' + e1.message : 'OK');
  console.log('trader_snapshots_v2:', e2 ? 'ERROR: ' + e2.message : 'OK');
  console.log('refresh_jobs:', e3 ? 'ERROR: ' + e3.message : 'OK');

  // Check existing bybit data in old table
  const { data: oldBybit, error: e4 } = await db.from('trader_snapshots').select('*').eq('source', 'bybit').order('roi', { ascending: false }).limit(10);
  console.log('\nExisting bybit data (trader_snapshots):', e4 ? 'ERROR: ' + e4.message : (oldBybit?.length ?? 0) + ' rows');
  if (oldBybit && oldBybit.length > 0) {
    console.log('\nTop 10 Bybit traders (old table):');
    for (const row of oldBybit) {
      console.log(`  ${row.source_trader_id} | ROI: ${row.roi}% | PnL: ${row.pnl} | Season: ${row.season_id} | Score: ${row.arena_score}`);
    }
  }

  // Check trader_sources for bybit
  const { data: sources, error: e5 } = await db.from('trader_sources').select('*').eq('source', 'bybit').limit(5);
  console.log('\nBybit trader_sources:', e5 ? 'ERROR: ' + e5.message : (sources?.length ?? 0) + ' rows');
  if (sources && sources.length > 0) {
    console.log('Sample source:', JSON.stringify(sources[0], null, 2));
  }

  // Count all bybit snapshots
  const { count, error: e6 } = await db.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bybit');
  console.log('\nTotal bybit snapshots:', e6 ? 'ERROR: ' + e6.message : count);

  // Check by season
  for (const season of ['7D', '30D', '90D']) {
    const { count: c } = await db.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bybit').eq('season_id', season);
    console.log(`  ${season}: ${c ?? 0} rows`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
