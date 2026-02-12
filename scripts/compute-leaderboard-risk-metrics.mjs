#!/usr/bin/env node
/**
 * Compute Sharpe, Sortino, Profit Factor, Calmar for leaderboard_ranks
 * from trader_equity_curve data. Uses JS computation to avoid heavy SQL.
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env.local') });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

function computeMetrics(roiSeries) {
  // roiSeries: array of {roi_pct} sorted by date
  if (roiSeries.length < 6) return null; // need >=5 daily returns
  
  const returns = [];
  for (let i = 1; i < roiSeries.length; i++) {
    returns.push(roiSeries[i] - roiSeries[i - 1]);
  }
  if (returns.length < 5) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);

  const negReturns = returns.filter(r => r < 0);
  const downsideVar = negReturns.length > 0
    ? negReturns.reduce((a, r) => a + r * r, 0) / negReturns.length
    : 0;
  const downsideStd = Math.sqrt(downsideVar);

  const grossProfit = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));

  const sharpe = std > 0 ? Math.round(mean / std * Math.sqrt(365) * 10000) / 10000 : null;
  const sortino = downsideStd > 0 ? Math.round(mean / downsideStd * Math.sqrt(365) * 10000) / 10000 : null;
  const profitFactor = grossLoss > 0 
    ? Math.round(grossProfit / grossLoss * 10000) / 10000
    : (grossProfit > 0 ? 99.99 : null);

  const clamp = (v, lo, hi) => v == null ? null : Math.max(lo, Math.min(hi, v));

  return {
    sharpe: clamp(sharpe, -99, 99),
    sortino: clamp(sortino, -99, 99),
    profitFactor: clamp(profitFactor, 0, 99.99),
  };
}

async function main() {
  console.log('=== Compute Risk Metrics for leaderboard_ranks ===\n');

  // Ensure columns exist
  for (const col of ['sharpe_ratio NUMERIC', 'sortino_ratio NUMERIC', 'profit_factor NUMERIC', 'calmar_ratio NUMERIC']) {
    try { await pool.query(`ALTER TABLE leaderboard_ranks ADD COLUMN ${col}`); console.log(`Added: ${col.split(' ')[0]}`); }
    catch (e) { if (e.code !== '42701') throw e; }
  }

  // Before
  const before = (await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE sharpe_ratio IS NOT NULL AND sharpe_ratio != 0) as sharpe,
      COUNT(*) FILTER (WHERE sortino_ratio IS NOT NULL AND sortino_ratio != 0) as sortino,
      COUNT(*) FILTER (WHERE profit_factor IS NOT NULL AND profit_factor != 0) as pf,
      COUNT(*) FILTER (WHERE calmar_ratio IS NOT NULL AND calmar_ratio != 0) as calmar
    FROM leaderboard_ranks
  `)).rows[0];
  console.log('BEFORE:', before);

  // Load all equity curves sorted
  console.log('\nLoading equity curves...');
  const { rows: curves } = await pool.query(`
    SELECT source, source_trader_id, period, data_date, roi_pct::float
    FROM trader_equity_curve
    WHERE period IN ('7D', '30D', '90D')
    ORDER BY source, source_trader_id, period, data_date
  `);
  console.log(`Loaded ${curves.length} curve points`);

  // Group by source|trader|period
  const grouped = new Map();
  for (const r of curves) {
    const k = `${r.source}|${r.source_trader_id}|${r.period}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(r.roi_pct);
  }
  console.log(`Unique curves: ${grouped.size}`);

  // Compute metrics for each curve
  const metricsMap = new Map(); // key -> {sharpe, sortino, profitFactor}
  let computed = 0;
  for (const [k, rois] of grouped) {
    const m = computeMetrics(rois);
    if (m) {
      metricsMap.set(k, m);
      computed++;
    }
  }
  console.log(`Computed metrics for ${computed} curves`);

  // Load leaderboard_ranks
  console.log('\nLoading leaderboard_ranks...');
  const { rows: ranks } = await pool.query(`
    SELECT id, source, source_trader_id, season_id, roi::float, max_drawdown::float
    FROM leaderboard_ranks
    WHERE season_id IN ('7D', '30D', '90D')
  `);
  console.log(`Loaded ${ranks.length} ranks`);

  // Match and build updates
  const updates = [];
  const periodDays = { '7D': 7, '30D': 30, '90D': 90 };

  for (const r of ranks) {
    // Try direct match
    let k = `${r.source}|${r.source_trader_id}|${r.season_id}`;
    let m = metricsMap.get(k);
    // Try binance fallback for binance_futures
    if (!m && r.source === 'binance_futures') {
      k = `binance|${r.source_trader_id}|${r.season_id}`;
      m = metricsMap.get(k);
    }

    const days = periodDays[r.season_id];
    let calmar = null;
    if (r.max_drawdown > 0 && r.roi != null && days) {
      calmar = Math.round((r.roi / days * 365 / r.max_drawdown) * 10000) / 10000;
      calmar = Math.max(-99, Math.min(99, calmar));
    }

    if (m || calmar != null) {
      updates.push({
        id: r.id,
        sharpe: m?.sharpe ?? null,
        sortino: m?.sortino ?? null,
        pf: m?.profitFactor ?? null,
        calmar,
      });
    }
  }
  console.log(`Updates to apply: ${updates.length}`);

  // Batch update in chunks
  const CHUNK = 500;
  let totalUpdated = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const values = chunk.map((u, idx) => {
      const base = idx * 5 + 1;
      return `($${base}, $${base+1}::numeric, $${base+2}::numeric, $${base+3}::numeric, $${base+4}::numeric)`;
    }).join(',');
    const params = chunk.flatMap(u => [u.id, u.sharpe, u.sortino, u.pf, u.calmar]);

    const result = await pool.query(`
      UPDATE leaderboard_ranks lr SET
        sharpe_ratio = COALESCE(v.sharpe, lr.sharpe_ratio),
        sortino_ratio = COALESCE(v.sortino, lr.sortino_ratio),
        profit_factor = COALESCE(v.pf, lr.profit_factor),
        calmar_ratio = COALESCE(v.calmar, lr.calmar_ratio)
      FROM (VALUES ${values}) AS v(id, sharpe, sortino, pf, calmar)
      WHERE lr.id = v.id::int
    `, params);
    totalUpdated += result.rowCount;
    if ((i / CHUNK) % 20 === 0) console.log(`  Batch ${Math.floor(i/CHUNK)+1}/${Math.ceil(updates.length/CHUNK)} (total: ${totalUpdated})`);
  }
  console.log(`\nTotal updated: ${totalUpdated}`);

  // After
  const after = (await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE sharpe_ratio IS NOT NULL AND sharpe_ratio != 0) as sharpe,
      COUNT(*) FILTER (WHERE sortino_ratio IS NOT NULL AND sortino_ratio != 0) as sortino,
      COUNT(*) FILTER (WHERE profit_factor IS NOT NULL AND profit_factor != 0) as pf,
      COUNT(*) FILTER (WHERE calmar_ratio IS NOT NULL AND calmar_ratio != 0) as calmar
    FROM leaderboard_ranks
  `)).rows[0];
  console.log('\nAFTER:', after);

  // Sample
  const sample = await pool.query(`
    SELECT source, source_trader_id, season_id, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio
    FROM leaderboard_ranks WHERE sharpe_ratio IS NOT NULL AND sharpe_ratio != 0
    ORDER BY sharpe_ratio DESC LIMIT 10
  `);
  console.log('\nTop Sharpe:');
  console.table(sample.rows);

  await pool.end();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
