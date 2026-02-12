#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

async function main() {
  console.time('total');
  
  const traders = await pool.query(`SELECT DISTINCT source, source_trader_id FROM leaderboard_ranks`);
  console.log(`${traders.rows.length} traders in leaderboard_ranks`);

  console.log('Fetching all equity curve data...');
  const allCurves = await pool.query(`
    SELECT source, source_trader_id, roi_pct::float as roi_pct
    FROM trader_equity_curve
    ORDER BY source, source_trader_id, data_date ASC
  `);
  console.log(`Loaded ${allCurves.rows.length} curve points`);

  const curveMap = new Map();
  for (const row of allCurves.rows) {
    const key = `${row.source}|${row.source_trader_id}`;
    if (!curveMap.has(key)) curveMap.set(key, []);
    curveMap.get(key).push(row.roi_pct);
  }

  const updates = [];
  let skipped = 0;

  for (const { source, source_trader_id } of traders.rows) {
    const points = curveMap.get(`${source}|${source_trader_id}`);
    if (!points || points.length < 5) { skipped++; continue; }

    const returns = [];
    for (let i = 1; i < points.length; i++) {
      const base = 100 + points[i - 1];
      if (base === 0) continue;
      returns.push((points[i] - points[i - 1]) / Math.abs(base));
    }
    if (returns.length < 5) { skipped++; continue; }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length);
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : null;

    const downsideVar = returns.filter(r => r < 0).reduce((a, r) => a + r ** 2, 0) / returns.length;
    const sortino = Math.sqrt(downsideVar) > 0 ? (mean / Math.sqrt(downsideVar)) * Math.sqrt(365) : null;

    const posSum = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
    const negSum = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
    const pf = negSum > 0 ? posSum / negSum : (posSum > 0 ? 999.99 : null);

    const clamp = (v, lo, hi) => v === null ? null : Math.max(lo, Math.min(hi, parseFloat(v.toFixed(4))));
    updates.push([clamp(sharpe, -50, 50), clamp(sortino, -50, 50), clamp(pf, 0, 999.99), source, source_trader_id]);
  }

  console.log(`Computed ${updates.length} metrics, skipped ${skipped}`);

  // Sequential single-row updates to avoid deadlocks
  let totalUpdated = 0;
  for (let i = 0; i < updates.length; i++) {
    const [s, so, pf, src, stid] = updates[i];
    const res = await pool.query(
      `UPDATE leaderboard_ranks SET sharpe_ratio=$1, sortino_ratio=$2, profit_factor=$3 WHERE source=$4 AND source_trader_id=$5`,
      [s, so, pf, src, stid]
    );
    totalUpdated += res.rowCount;
    if (i % 500 === 0) process.stdout.write(`${i}/${updates.length} `);
  }

  console.log(`\nRows updated: ${totalUpdated}`);

  const v = await pool.query(`
    SELECT COUNT(*) total, COUNT(sharpe_ratio) has_sharpe, COUNT(sortino_ratio) has_sortino, COUNT(profit_factor) has_pf,
      ROUND(AVG(sharpe_ratio)::numeric,4) avg_sharpe, ROUND(AVG(sortino_ratio)::numeric,4) avg_sortino, ROUND(AVG(profit_factor)::numeric,4) avg_pf
    FROM leaderboard_ranks
  `);
  console.log('Verification:', v.rows[0]);
  console.timeEnd('total');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
