#!/usr/bin/env node
/**
 * 快速验证HTX数据中的WR和MDD字段
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(url, key);

async function main() {
  // 查询90D period的top 10 HTX traders
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, roi, win_rate, max_drawdown, pnl, arena_score')
    .eq('source', 'htx_futures')
    .eq('season_id', '90D')
    .order('arena_score', { ascending: false })
    .limit(10);

  if (error) {
    console.error('Query error:', error);
    process.exit(1);
  }

  console.log('\n=== HTX Futures Top 10 (90D) ===\n');
  console.log('Trader ID\t\tROI%\tWR%\tMDD%\tPnL\t\tArena Score');
  console.log('-'.repeat(80));
  
  for (const row of data) {
    const wr = row.win_rate !== null ? row.win_rate.toFixed(1) : 'NULL';
    const mdd = row.max_drawdown !== null ? row.max_drawdown.toFixed(1) : 'NULL';
    const pnl = row.pnl !== null ? row.pnl.toFixed(0) : 'NULL';
    console.log(`${row.source_trader_id.slice(0,12)}\t${row.roi.toFixed(1)}\t${wr}\t${mdd}\t${pnl}\t${row.arena_score.toFixed(1)}`);
  }

  // 统计NULL值数量
  const { data: stats } = await supabase
    .from('trader_snapshots')
    .select('win_rate, max_drawdown')
    .eq('source', 'htx_futures')
    .eq('season_id', '90D');

  const totalCount = stats.length;
  const nullWR = stats.filter(s => s.win_rate === null).length;
  const nullMDD = stats.filter(s => s.max_drawdown === null).length;

  console.log('\n=== Field Coverage ===');
  console.log(`Total HTX traders (90D): ${totalCount}`);
  console.log(`Win Rate NULL: ${nullWR} (${(nullWR/totalCount*100).toFixed(1)}%)`);
  console.log(`Max Drawdown NULL: ${nullMDD} (${(nullMDD/totalCount*100).toFixed(1)}%)`);
  console.log('\n✅ 验证完成');
}

main().catch(console.error);
