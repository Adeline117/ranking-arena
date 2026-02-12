#!/usr/bin/env node
/**
 * Compute advanced metrics for trader_snapshots.
 * Uses bulk SQL for fast updates.
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(import.meta.dirname, '../.env.local') });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

function dailyReturns(roiSeries) {
  if (roiSeries.length < 2) return [];
  const returns = [];
  for (let i = 1; i < roiSeries.length; i++) {
    const prev = 1 + roiSeries[i - 1] / 100;
    const curr = 1 + roiSeries[i] / 100;
    if (prev !== 0) returns.push(curr / prev - 1);
  }
  return returns;
}

function annualizedVol(returns) {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

function downsideVol(returns) {
  const neg = returns.filter(r => r < 0);
  if (neg.length < 2) return null;
  const variance = neg.reduce((a, r) => a + r * r, 0) / (neg.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

function computeBeta(tr, br) {
  const n = Math.min(tr.length, br.length);
  if (n < 3) return null;
  const meanT = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const meanB = br.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let cov = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (tr[i] - meanT) * (br[i] - meanB);
    varB += (br[i] - meanB) ** 2;
  }
  return varB === 0 ? null : cov / varB;
}

function maxConsec(pnls, cond) {
  let max = 0, cur = 0;
  for (const p of pnls) {
    if (cond(p)) { cur++; max = Math.max(max, cur); } else cur = 0;
  }
  return max;
}

function clamp(v, lo, hi) { return v == null || !isFinite(v) ? null : Math.max(lo, Math.min(hi, v)); }

async function fetchBinancePrices(symbol, days) {
  const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=1d&limit=${days + 1}`;
  console.log(`Fetching ${symbol} ${days}D...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Binance ${resp.status}`);
  const data = await resp.json();
  const entries = data.map(k => ({ date: new Date(k[0]).toISOString().slice(0, 10), price: parseFloat(k[4]) }));
  const byDate = new Map(entries.map(e => [e.date, e.price]));
  const sorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const retByDate = new Map();
  for (let i = 1; i < sorted.length; i++) {
    retByDate.set(sorted[i][0], sorted[i][1] / sorted[i - 1][1] - 1);
  }
  return retByDate;
}

async function main() {
  console.log('=== Computing Advanced Metrics ===\n');

  // Before
  const before = (await pool.query(`
    SELECT COUNT(*) FILTER (WHERE volatility_pct IS NOT NULL AND volatility_pct != 0) as vol,
      COUNT(*) FILTER (WHERE downside_volatility_pct IS NOT NULL AND downside_volatility_pct != 0) as dvol,
      COUNT(*) FILTER (WHERE calmar_ratio IS NOT NULL AND calmar_ratio != 0) as calmar,
      COUNT(*) FILTER (WHERE recovery_factor IS NOT NULL AND recovery_factor != 0) as recov,
      COUNT(*) FILTER (WHERE max_consecutive_wins IS NOT NULL) as mcw,
      COUNT(*) FILTER (WHERE max_consecutive_losses IS NOT NULL) as mcl,
      COUNT(*) FILTER (WHERE alpha IS NOT NULL AND alpha != 0) as alpha,
      COUNT(*) FILTER (WHERE beta_btc IS NOT NULL AND beta_btc != 0) as beta_btc,
      COUNT(*) FILTER (WHERE beta_eth IS NOT NULL AND beta_eth != 0) as beta_eth,
      COUNT(*) as total FROM trader_snapshots
  `)).rows[0];
  console.log('BEFORE:', before);

  // Fetch benchmark data
  const bench = {};
  for (const days of [7, 30, 90]) {
    bench[days] = {
      btc: await fetchBinancePrices('BTCUSDT', days),
      eth: await fetchBinancePrices('ETHUSDT', days),
    };
    await new Promise(r => setTimeout(r, 300));
  }

  const periodDays = { '7D': 7, '30D': 30, '90D': 90 };

  // Load snapshots
  const { rows: snaps } = await pool.query(`SELECT id, source, source_trader_id, season_id, roi::float, max_drawdown::float FROM trader_snapshots`);
  console.log(`\nSnapshots: ${snaps.length}`);

  // Load equity curves
  const { rows: curveRows } = await pool.query(`
    SELECT source, source_trader_id, period, data_date, roi_pct::float as roi_pct
    FROM trader_equity_curve WHERE period IN ('7D','30D','90D')
    ORDER BY source, source_trader_id, period, data_date
  `);
  console.log(`Equity curve rows: ${curveRows.length}`);

  // Index curves: key -> {dates: [], rois: []}
  const curves = new Map();
  for (const r of curveRows) {
    const k = `${r.source}|${r.source_trader_id}|${r.period}`;
    if (!curves.has(k)) curves.set(k, { dates: [], rois: [] });
    const c = curves.get(k);
    c.dates.push(r.data_date.toISOString().slice(0, 10));
    c.rois.push(r.roi_pct);
  }
  console.log(`Unique curves: ${curves.size}`);

  // Load positions
  const { rows: posRows } = await pool.query(`
    SELECT source, source_trader_id, pnl_usd::float as pnl
    FROM trader_position_history WHERE close_time IS NOT NULL
    ORDER BY source, source_trader_id, close_time
  `);
  const posMap = new Map();
  for (const r of posRows) {
    const k = `${r.source}|${r.source_trader_id}`;
    if (!posMap.has(k)) posMap.set(k, []);
    posMap.get(k).push(r.pnl);
  }
  console.log(`Traders with positions: ${posMap.size}\n`);

  // Compute all updates in memory
  console.log('Computing metrics...');
  const updates = []; // {id, vol, dvol, calmar, recov, mcw, mcl, alpha, beta_btc, beta_eth}
  
  for (const snap of snaps) {
    const u = { id: snap.id };
    const k = `${snap.source}|${snap.source_trader_id}|${snap.season_id}`;
    const curve = curves.get(k);
    const days = periodDays[snap.season_id];

    if (curve && curve.rois.length >= 2) {
      const rets = dailyReturns(curve.rois);
      u.vol = clamp(annualizedVol(rets), 0, 9999.9999);
      u.dvol = clamp(downsideVol(rets), 0, 9999.9999);

      if (days && bench[days]) {
        // Align returns by date
        const dates = curve.dates.slice(1);
        const trA = [], btcA = [], ethA = [];
        for (let i = 0; i < dates.length; i++) {
          const d = dates[i];
          const br = bench[days].btc.get(d);
          const er = bench[days].eth.get(d);
          if (br !== undefined && er !== undefined) {
            trA.push(rets[i]); btcA.push(br); ethA.push(er);
          }
        }
        const bBtc = computeBeta(trA, btcA);
        const bEth = computeBeta(trA, ethA);
        u.beta_btc = clamp(bBtc, -9999, 9999);
        u.beta_eth = clamp(bEth, -9999, 9999);
        
        if (bBtc !== null && isFinite(bBtc)) {
          const traderRet = curve.rois[curve.rois.length - 1] / 100;
          const btcRet = btcA.reduce((a, b) => a + b, 0);
          const alpha = ((traderRet - bBtc * btcRet) / days) * 365 * 100;
          u.alpha = clamp(alpha, -999999, 999999);
        }
      }
    }

    const md = snap.max_drawdown;
    const roi = snap.roi;
    if (md > 0 && roi != null && !isNaN(roi) && days) {
      u.calmar = clamp((roi / days * 365) / md, -9999, 9999);
      u.recov = clamp(roi / md, -9999, 9999);
    }

    const posKey = `${snap.source}|${snap.source_trader_id}`;
    const pnls = posMap.get(posKey);
    if (pnls) {
      u.mcw = maxConsec(pnls, p => p > 0);
      u.mcl = maxConsec(pnls, p => p <= 0);
    }

    updates.push(u);
  }

  console.log(`Updates computed: ${updates.length}`);

  // Filter updates that actually have data
  const meaningful = updates.filter(u =>
    u.vol != null || u.dvol != null || u.calmar != null || u.recov != null ||
    u.mcw != null || u.mcl != null || u.alpha != null || u.beta_btc != null || u.beta_eth != null
  );
  console.log(`Meaningful updates: ${meaningful.length}`);

  // Batch UPDATE using UPDATE ... FROM (VALUES ...) in chunks
  const CHUNK = 1000;
  let totalUpdated = 0;
  for (let i = 0; i < meaningful.length; i += CHUNK) {
    const chunk = meaningful.slice(i, i + CHUNK);
    const values = chunk.map(u =>
      `(${u.id}::bigint,${u.vol ?? 'NULL'}::numeric,${u.dvol ?? 'NULL'}::numeric,${u.calmar ?? 'NULL'}::numeric,${u.recov ?? 'NULL'}::numeric,${u.mcw ?? 'NULL'}::int,${u.mcl ?? 'NULL'}::int,${u.alpha ?? 'NULL'}::numeric,${u.beta_btc ?? 'NULL'}::numeric,${u.beta_eth ?? 'NULL'}::numeric)`
    ).join(',');
    
    const result = await pool.query(`
      UPDATE trader_snapshots s SET
        volatility_pct = COALESCE(u.vol, s.volatility_pct),
        downside_volatility_pct = COALESCE(u.dvol, s.downside_volatility_pct),
        calmar_ratio = COALESCE(u.calmar, s.calmar_ratio),
        recovery_factor = COALESCE(u.recov, s.recovery_factor),
        max_consecutive_wins = COALESCE(u.mcw, s.max_consecutive_wins),
        max_consecutive_losses = COALESCE(u.mcl, s.max_consecutive_losses),
        alpha = COALESCE(u.alpha, s.alpha),
        beta_btc = COALESCE(u.beta_btc, s.beta_btc),
        beta_eth = COALESCE(u.beta_eth, s.beta_eth)
      FROM (VALUES ${values}) AS u(id, vol, dvol, calmar, recov, mcw, mcl, alpha, beta_btc, beta_eth)
      WHERE s.id = u.id
    `);
    totalUpdated += result.rowCount;
    console.log(`Batch ${Math.floor(i/CHUNK)+1}/${Math.ceil(meaningful.length/CHUNK)}: updated ${result.rowCount} (total: ${totalUpdated})`);
  }

  // After
  const after = (await pool.query(`
    SELECT COUNT(*) FILTER (WHERE volatility_pct IS NOT NULL AND volatility_pct != 0) as vol,
      COUNT(*) FILTER (WHERE downside_volatility_pct IS NOT NULL AND downside_volatility_pct != 0) as dvol,
      COUNT(*) FILTER (WHERE calmar_ratio IS NOT NULL AND calmar_ratio != 0) as calmar,
      COUNT(*) FILTER (WHERE recovery_factor IS NOT NULL AND recovery_factor != 0) as recov,
      COUNT(*) FILTER (WHERE max_consecutive_wins IS NOT NULL) as mcw,
      COUNT(*) FILTER (WHERE max_consecutive_losses IS NOT NULL) as mcl,
      COUNT(*) FILTER (WHERE alpha IS NOT NULL AND alpha != 0) as alpha,
      COUNT(*) FILTER (WHERE beta_btc IS NOT NULL AND beta_btc != 0) as beta_btc,
      COUNT(*) FILTER (WHERE beta_eth IS NOT NULL AND beta_eth != 0) as beta_eth,
      COUNT(*) as total FROM trader_snapshots
  `)).rows[0];
  console.log('\nAFTER:', after);
  console.log('\n=== Done ===');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
