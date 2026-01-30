/**
 * Verify fix: what does the homepage look like after ROI filter?
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config({ path: '.env.local' });
config();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function verify() {
  console.log('=== Post-Fix: Top 20 for 90D (ROI <= 10000) ===\n');
  
  const { data: top20 } = await supabase
    .from('trader_snapshots')
    .select('source, source_trader_id, roi, pnl, arena_score, win_rate, max_drawdown')
    .eq('season_id', '90D')
    .not('arena_score', 'is', null)
    .gt('arena_score', 0)
    .lte('roi', 10000)
    .order('arena_score', { ascending: false })
    .limit(30);
  
  if (!top20 || top20.length === 0) {
    console.log('NO DATA after filtering! This means 90D has no traders with ROI <= 10000%');
    
    // Check what we'd get for 30D
    console.log('\n=== Fallback: Top 20 for 30D (ROI <= 10000) ===\n');
    const { data: top30d } = await supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, roi, pnl, arena_score, win_rate, max_drawdown')
      .eq('season_id', '30D')
      .not('arena_score', 'is', null)
      .gt('arena_score', 0)
      .lte('roi', 10000)
      .order('arena_score', { ascending: false })
      .limit(30);
    
    if (top30d) {
      // Dedupe
      const seen = new Set();
      for (const t of top30d) {
        const key = `${t.source}:${t.source_trader_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`  ${t.source.padEnd(20)} | ${(t.source_trader_id || '').substring(0, 25).padEnd(25)} | score: ${parseFloat(t.arena_score).toFixed(2).padEnd(7)} | ROI: ${parseFloat(t.roi).toFixed(1)}% | WR: ${t.win_rate ?? 'null'} | MDD: ${t.max_drawdown ?? 'null'}`);
      }
    }
    
    // Also check 7D
    console.log('\n=== Fallback: Top 20 for 7D (ROI <= 10000) ===\n');
    const { data: top7d } = await supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, roi, pnl, arena_score, win_rate, max_drawdown')
      .eq('season_id', '7D')
      .not('arena_score', 'is', null)
      .gt('arena_score', 0)
      .lte('roi', 10000)
      .order('arena_score', { ascending: false })
      .limit(30);
    
    if (top7d) {
      const seen = new Set();
      for (const t of top7d) {
        const key = `${t.source}:${t.source_trader_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`  ${t.source.padEnd(20)} | ${(t.source_trader_id || '').substring(0, 25).padEnd(25)} | score: ${parseFloat(t.arena_score).toFixed(2).padEnd(7)} | ROI: ${parseFloat(t.roi).toFixed(1)}% | WR: ${t.win_rate ?? 'null'} | MDD: ${t.max_drawdown ?? 'null'}`);
      }
    }
    return;
  }
  
  // Dedupe top20
  const seen = new Set();
  let count = 0;
  for (const t of top20) {
    const key = `${t.source}:${t.source_trader_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    count++;
    console.log(`  ${t.source.padEnd(20)} | ${(t.source_trader_id || '').substring(0, 25).padEnd(25)} | score: ${parseFloat(t.arena_score).toFixed(2).padEnd(7)} | ROI: ${parseFloat(t.roi).toFixed(1)}% | WR: ${t.win_rate ?? 'null'} | MDD: ${t.max_drawdown ?? 'null'}`);
  }
  
  // Count by platform
  console.log('\n--- Platform distribution (90D, ROI <= 10000) ---');
  const { data: platformCounts } = await supabase
    .from('trader_snapshots')
    .select('source')
    .eq('season_id', '90D')
    .not('arena_score', 'is', null)
    .gt('arena_score', 0)
    .lte('roi', 10000);
  
  if (platformCounts) {
    const counts = {};
    for (const r of platformCounts) {
      counts[r.source] = (counts[r.source] || 0) + 1;
    }
    for (const [src, cnt] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${src}: ${cnt}`);
    }
  }
}

verify().catch(console.error);
