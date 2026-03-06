#!/usr/bin/env node
/**
 * Compute sharpe_ratio, sortino_ratio, profit_factor, avg_holding_hours
 * for all trader_snapshots using SQL for heavy computation.
 */

import { execSync } from 'child_process';

const PSQL = '/opt/homebrew/opt/libpq/bin/psql';
const DB = process.env.DATABASE_URL;

function sql(query) {
  return execSync(`${PSQL} "${DB}" -t -A -c "${query.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    timeout: 600000,
  }).trim();
}

function sqlMulti(query) {
  return execSync(`${PSQL} "${DB}" -c "${query.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    timeout: 600000,
  }).trim();
}

// Before counts
console.log('=== BEFORE ===');
console.log('Total snapshots:', sql("SELECT COUNT(*) FROM trader_snapshots"));
console.log('Non-zero sharpe:', sql("SELECT COUNT(*) FROM trader_snapshots WHERE sharpe_ratio IS NOT NULL AND sharpe_ratio != 0"));
console.log('Non-zero sortino:', sql("SELECT COUNT(*) FROM trader_snapshots WHERE sortino_ratio IS NOT NULL AND sortino_ratio != 0"));
console.log('Non-zero profit_factor:', sql("SELECT COUNT(*) FROM trader_snapshots WHERE profit_factor IS NOT NULL AND profit_factor != 0"));
console.log('Non-null avg_holding_hours:', sql("SELECT COUNT(*) FROM trader_snapshots WHERE avg_holding_hours IS NOT NULL"));

// Step 1: Compute sharpe, sortino, profit_factor from equity curves using SQL
console.log('\n=== Computing metrics from equity curves ===');

const updateMetricsSQL = `
WITH daily_returns AS (
  SELECT
    source,
    source_trader_id,
    period,
    data_date,
    roi_pct - LAG(roi_pct) OVER (
      PARTITION BY source, source_trader_id, period
      ORDER BY data_date
    ) AS daily_ret
  FROM trader_equity_curve
  WHERE period IN ('7D', '30D', '90D')
),
metrics AS (
  SELECT
    source,
    source_trader_id,
    period AS season_id,
    AVG(daily_ret) AS mean_ret,
    STDDEV_SAMP(daily_ret) AS std_ret,
    SQRT(
      SUM(CASE WHEN daily_ret < 0 THEN daily_ret * daily_ret ELSE 0 END) / NULLIF(COUNT(*), 0)
    ) AS downside_dev,
    SUM(CASE WHEN daily_ret > 0 THEN daily_ret ELSE 0 END) AS gross_profit,
    ABS(SUM(CASE WHEN daily_ret < 0 THEN daily_ret ELSE 0 END)) AS gross_loss,
    COUNT(*) AS n
  FROM daily_returns
  WHERE daily_ret IS NOT NULL
  GROUP BY source, source_trader_id, period
  HAVING COUNT(*) >= 2
),
computed AS (
  SELECT
    source,
    source_trader_id,
    season_id,
    CASE WHEN std_ret > 0 THEN LEAST(99, GREATEST(-99, ROUND(((mean_ret - 0.0001369863) / std_ret)::numeric, 4))) ELSE 0 END AS sharpe,
    CASE WHEN downside_dev > 0 THEN LEAST(99, GREATEST(-99, ROUND(((mean_ret - 0.0001369863) / downside_dev)::numeric, 4))) ELSE 0 END AS sortino,
    CASE WHEN gross_loss > 0 THEN LEAST(99.99, ROUND((gross_profit / gross_loss)::numeric, 4))
         WHEN gross_profit > 0 THEN 99.99
         ELSE 0 END AS pf
  FROM metrics
)
UPDATE trader_snapshots ts
SET
  sharpe_ratio = c.sharpe,
  sortino_ratio = c.sortino,
  profit_factor = c.pf
FROM computed c
WHERE ts.source = c.source
  AND ts.source_trader_id = c.source_trader_id
  AND ts.season_id = c.season_id
`;

console.log('Running metrics update...');
const result1 = sqlMulti(updateMetricsSQL);
console.log(result1);

// Step 2: Compute avg_holding_hours from position history
console.log('\n=== Computing avg_holding_hours from position history ===');

const updateHoldingSQL = `
WITH avg_hours AS (
  SELECT
    source,
    source_trader_id,
    ROUND(AVG(EXTRACT(EPOCH FROM (close_time - open_time)) / 3600)::numeric, 2) AS avg_h
  FROM trader_position_history
  WHERE open_time IS NOT NULL
    AND close_time IS NOT NULL
    AND close_time > open_time
  GROUP BY source, source_trader_id
)
UPDATE trader_snapshots ts
SET avg_holding_hours = ah.avg_h
FROM avg_hours ah
WHERE ts.source = ah.source
  AND ts.source_trader_id = ah.source_trader_id
`;

const result2 = sqlMulti(updateHoldingSQL);
console.log(result2);

// After counts
console.log('\n=== AFTER ===');
console.log('Non-zero sharpe:', sql("SELECT COUNT(*) FROM trader_snapshots WHERE sharpe_ratio IS NOT NULL AND sharpe_ratio != 0"));
console.log('Non-zero sortino:', sql("SELECT COUNT(*) FROM trader_snapshots WHERE sortino_ratio IS NOT NULL AND sortino_ratio != 0"));
console.log('Non-zero profit_factor:', sql("SELECT COUNT(*) FROM trader_snapshots WHERE profit_factor IS NOT NULL AND profit_factor != 0"));
console.log('Non-null avg_holding_hours:', sql("SELECT COUNT(*) FROM trader_snapshots WHERE avg_holding_hours IS NOT NULL"));

// Sample
console.log('\n=== Sample results ===');
console.log(sqlMulti("SELECT source, source_trader_id, season_id, sharpe_ratio, sortino_ratio, profit_factor, avg_holding_hours FROM trader_snapshots WHERE sharpe_ratio != 0 LIMIT 10"));

console.log('\nDone!');
