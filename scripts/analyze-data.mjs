/**
 * Task 1: Analyze data distribution across platforms and seasons
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config({ path: '.env.local' });
config();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function analyze() {
  console.log('=== Task 1: Data Distribution Analysis ===\n');

  // 1. Get all distinct sources and seasons
  const { data: sources } = await supabase
    .from('trader_snapshots')
    .select('source')
    .limit(1);
  
  // Get counts by source and season
  for (const season of ['7D', '30D', '90D']) {
    console.log(`\n--- Season: ${season} ---`);
    
    // Get all data for this season
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('source, arena_score, win_rate, max_drawdown, roi, pnl')
      .eq('season_id', season)
      .limit(10000);
    
    if (error) {
      console.error(`Error for ${season}:`, error.message);
      continue;
    }
    
    if (!data || data.length === 0) {
      console.log('No data found');
      continue;
    }
    
    // Group by source
    const bySource = {};
    for (const row of data) {
      if (!bySource[row.source]) {
        bySource[row.source] = {
          total: 0,
          arenaScoreNull: 0,
          arenaScoreZero: 0,
          arenaScoreDistribution: [],
          winRateNull: 0,
          maxDrawdownNull: 0,
          roiValues: [],
          roiAbove10000: 0,
          roiAbove100000: 0,
        };
      }
      const s = bySource[row.source];
      s.total++;
      
      const score = row.arena_score != null ? parseFloat(row.arena_score) : null;
      if (score === null) s.arenaScoreNull++;
      else if (score === 0) s.arenaScoreZero++;
      if (score != null) s.arenaScoreDistribution.push(score);
      
      if (row.win_rate === null || row.win_rate === undefined) s.winRateNull++;
      if (row.max_drawdown === null || row.max_drawdown === undefined) s.maxDrawdownNull++;
      
      const roi = row.roi != null ? parseFloat(row.roi) : null;
      if (roi !== null) {
        s.roiValues.push(roi);
        if (Math.abs(roi) > 10000) s.roiAbove10000++;
        if (Math.abs(roi) > 100000) s.roiAbove100000++;
      }
    }
    
    // Print summary
    for (const [source, stats] of Object.entries(bySource)) {
      const s = stats;
      const scores = s.arenaScoreDistribution;
      scores.sort((a, b) => a - b);
      
      const rois = s.roiValues;
      rois.sort((a, b) => a - b);
      
      const percentile = (arr, p) => {
        if (arr.length === 0) return 'N/A';
        const idx = Math.floor(arr.length * p / 100);
        return arr[Math.min(idx, arr.length - 1)].toFixed(2);
      };
      
      console.log(`\n  ${source}:`);
      console.log(`    Total traders: ${s.total}`);
      console.log(`    Arena score null: ${s.arenaScoreNull} (${(s.arenaScoreNull/s.total*100).toFixed(1)}%)`);
      console.log(`    Arena score = 0: ${s.arenaScoreZero} (${(s.arenaScoreZero/s.total*100).toFixed(1)}%)`);
      console.log(`    Arena score - min: ${percentile(scores, 0)}, p25: ${percentile(scores, 25)}, p50: ${percentile(scores, 50)}, p75: ${percentile(scores, 75)}, p95: ${percentile(scores, 95)}, max: ${percentile(scores, 100)}`);
      console.log(`    Win rate null: ${s.winRateNull} (${(s.winRateNull/s.total*100).toFixed(1)}%)`);
      console.log(`    Max drawdown null: ${s.maxDrawdownNull} (${(s.maxDrawdownNull/s.total*100).toFixed(1)}%)`);
      console.log(`    ROI > 10000%: ${s.roiAbove10000}, ROI > 100000%: ${s.roiAbove100000}`);
      console.log(`    ROI - min: ${percentile(rois, 0)}, p50: ${percentile(rois, 50)}, p95: ${percentile(rois, 95)}, max: ${percentile(rois, 100)}`);
    }
  }

  // 2. Check what the homepage currently shows (top 10 by arena_score for 90D)
  console.log('\n\n=== Current Homepage Top 10 (90D, all sources) ===');
  const { data: top10 } = await supabase
    .from('trader_snapshots')
    .select('source, source_trader_id, roi, pnl, arena_score, win_rate, max_drawdown')
    .eq('season_id', '90D')
    .not('arena_score', 'is', null)
    .gt('arena_score', 0)
    .order('arena_score', { ascending: false })
    .limit(20);
  
  if (top10) {
    for (const t of top10) {
      console.log(`  ${t.source} | ${t.source_trader_id.substring(0, 20).padEnd(20)} | score: ${parseFloat(t.arena_score).toFixed(2)} | ROI: ${parseFloat(t.roi).toFixed(2)}% | PnL: $${parseFloat(t.pnl).toFixed(0)} | WR: ${t.win_rate ?? 'null'} | MDD: ${t.max_drawdown ?? 'null'}`);
    }
  }

  // 3. Check specifically for extreme ROI values
  console.log('\n\n=== Extreme ROI Values (> 100000%) ===');
  const { data: extremeRoi } = await supabase
    .from('trader_snapshots')
    .select('source, source_trader_id, roi, pnl, arena_score, season_id')
    .gt('roi', 100000)
    .limit(50);
  
  if (extremeRoi) {
    for (const t of extremeRoi) {
      console.log(`  ${t.season_id} | ${t.source} | ${t.source_trader_id.substring(0, 20)} | ROI: ${parseFloat(t.roi).toFixed(0)}% | score: ${t.arena_score ? parseFloat(t.arena_score).toFixed(2) : 'null'}`);
    }
    console.log(`  Total extreme ROI entries: ${extremeRoi.length}`);
  }
}

analyze().catch(console.error);
