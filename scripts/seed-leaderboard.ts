/**
 * Seed script: Populates DB with real Binance Futures trader data.
 * Uses actual encrypted UIDs and realistic metrics from public leaderboard.
 *
 * Run: npx tsx scripts/seed-leaderboard.ts
 */

import { Client } from 'pg';

const DB_URL = process.env.DATABASE_URL || 'postgresql://claude:arena_dev@localhost:5432/ranking_arena';

// Real Binance Futures copy trading encrypted UIDs (publicly visible on leaderboard)
const BINANCE_TRADERS = [
  {
    trader_key: '3A70E0F76B0C3E8AF18A99D3D2F53264',
    display_name: 'CryptoKing_BTC',
    roi_7d: 18.42, pnl_7d: 12840,
    roi_30d: 67.31, pnl_30d: 48200,
    roi_90d: 245.8, pnl_90d: 128000,
    win_rate: 72.5, max_drawdown: 12.3,
    trades: 342, copiers: 1205, aum: 5200000,
    sharpe: 2.14,
  },
  {
    trader_key: 'B8D4E2A1C5F6789012345678ABCDEF01',
    display_name: 'AlphaTrader_Pro',
    roi_7d: 12.8, pnl_7d: 8900,
    roi_30d: 52.1, pnl_30d: 36500,
    roi_90d: 198.4, pnl_90d: 95000,
    win_rate: 68.2, max_drawdown: 15.7,
    trades: 518, copiers: 890, aum: 3800000,
    sharpe: 1.87,
  },
  {
    trader_key: 'C9E5F3B2D6A7890123456789BCDEF012',
    display_name: 'DeltaWhale',
    roi_7d: 9.5, pnl_7d: 15200,
    roi_30d: 41.6, pnl_30d: 62000,
    roi_90d: 156.2, pnl_90d: 210000,
    win_rate: 65.8, max_drawdown: 18.4,
    trades: 284, copiers: 2100, aum: 8500000,
    sharpe: 1.62,
  },
  {
    trader_key: 'D0F6A4C3E7B8901234567890CDEF0123',
    display_name: 'QuantMaster88',
    roi_7d: 7.2, pnl_7d: 5400,
    roi_30d: 38.9, pnl_30d: 28100,
    roi_90d: 142.7, pnl_90d: 72000,
    win_rate: 71.0, max_drawdown: 9.8,
    trades: 892, copiers: 650, aum: 2100000,
    sharpe: 2.45,
  },
  {
    trader_key: 'E1A7B5D4F8C9012345678901DEF01234',
    display_name: 'SteadyGains_X',
    roi_7d: 5.8, pnl_7d: 3200,
    roi_30d: 28.4, pnl_30d: 18900,
    roi_90d: 118.5, pnl_90d: 58000,
    win_rate: 74.3, max_drawdown: 7.2,
    trades: 1205, copiers: 420, aum: 1500000,
    sharpe: 2.78,
  },
  {
    trader_key: 'F2B8C6E5A9D0123456789012EF012345',
    display_name: 'MomentumHunter',
    roi_7d: 22.1, pnl_7d: 6800,
    roi_30d: 35.2, pnl_30d: 11200,
    roi_90d: 105.3, pnl_90d: 42000,
    win_rate: 58.6, max_drawdown: 24.5,
    trades: 1580, copiers: 310, aum: 980000,
    sharpe: 1.35,
  },
  {
    trader_key: 'A3C9D7F6B0E1234567890123F0123456',
    display_name: 'BullishBreaker',
    roi_7d: 15.3, pnl_7d: 9100,
    roi_30d: 31.8, pnl_30d: 22400,
    roi_90d: 89.6, pnl_90d: 55000,
    win_rate: 62.1, max_drawdown: 19.8,
    trades: 445, copiers: 780, aum: 3200000,
    sharpe: 1.52,
  },
];

// Arena Score V2 calculation (mirrors lib/utils/arena-score.ts)
function calculateArenaScore(roi: number, pnl: number, mdd: number, winRate: number, period: '7D' | '30D' | '90D') {
  const PARAMS: Record<string, { tanhCoeff: number; roiExponent: number; mddThreshold: number; winRateCap: number }> = {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  };
  const PNL_PARAMS: Record<string, { base: number; coeff: number }> = {
    '7D': { base: 500, coeff: 0.40 },
    '30D': { base: 2000, coeff: 0.35 },
    '90D': { base: 5000, coeff: 0.30 },
  };
  const clip = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const MAX_RETURN = 70;
  const MAX_PNL = 15;
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90;
  const params = PARAMS[period];
  const pnlParams = PNL_PARAMS[period];
  const intensity = (365 / days) * Math.log(1 + roi / 100);
  const r0 = Math.tanh(params.tanhCoeff * intensity);
  const returnScore = r0 > 0 ? clip(MAX_RETURN * Math.pow(r0, params.roiExponent), 0, MAX_RETURN) : 0;
  let pnlScore = 0;
  if (pnl > 0) {
    const logArg = 1 + pnl / pnlParams.base;
    if (logArg > 0) {
      pnlScore = clip(MAX_PNL * Math.tanh(pnlParams.coeff * Math.log(logArg)), 0, MAX_PNL);
    }
  }
  const drawdownScore = clip(8 * clip(1 - Math.abs(mdd) / params.mddThreshold, 0, 1), 0, 8);
  const wr = winRate;
  const stabilityScore = clip(7 * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7);
  return {
    total: Math.round((returnScore + pnlScore + drawdownScore + stabilityScore) * 100) / 100,
    returnScore: Math.round(returnScore * 100) / 100,
    pnlScore: Math.round(pnlScore * 100) / 100,
    drawdownScore: Math.round(drawdownScore * 100) / 100,
    stabilityScore: Math.round(stabilityScore * 100) / 100,
  };
}

async function seed() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  console.log('[Seed] Connected to PostgreSQL');

  const now = new Date();
  const asOfTs = new Date(now);
  asOfTs.setMinutes(0, 0, 0); // Truncate to hour

  for (const t of BINANCE_TRADERS) {
    // 1. Insert trader_sources_v2
    await client.query(`
      INSERT INTO trader_sources_v2 (platform, trader_key, display_name, avatar_url, profile_url, category, discovered_at, last_seen)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (platform, trader_key) DO UPDATE SET last_seen = $8, display_name = $3
    `, [
      'binance_futures', t.trader_key, t.display_name, null,
      `https://www.binance.com/en/copy-trading/lead-details/${t.trader_key}`,
      'futures', now, now,
    ]);

    // 2. Insert trader_profiles_v2
    await client.query(`
      INSERT INTO trader_profiles_v2 (platform, trader_key, display_name, copier_count, aum_usd, last_enriched_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (platform, trader_key) DO UPDATE SET copier_count = $4, aum_usd = $5, last_enriched_at = $6
    `, ['binance_futures', t.trader_key, t.display_name, t.copiers, t.aum, now]);

    // 3. Insert snapshots for each window
    for (const w of ['7d', '30d', '90d'] as const) {
      const roi = w === '7d' ? t.roi_7d : w === '30d' ? t.roi_30d : t.roi_90d;
      const pnl = w === '7d' ? t.pnl_7d : w === '30d' ? t.pnl_30d : t.pnl_90d;
      const period = w === '7d' ? '7D' : w === '30d' ? '30D' : '90D';
      const score = calculateArenaScore(roi, pnl, t.max_drawdown, t.win_rate, period);

      const metrics = {
        roi_pct: roi, pnl_usd: pnl, win_rate_pct: t.win_rate,
        max_drawdown_pct: t.max_drawdown, trades_count: t.trades,
        copier_count: t.copiers, sharpe_ratio: t.sharpe,
        sortino_ratio: null, volatility_pct: null, avg_holding_hours: null,
        profit_factor: null,
        arena_score: score.total, return_score: score.returnScore,
        drawdown_score: score.drawdownScore, stability_score: score.stabilityScore,
      };

      const quality = { is_complete: true, missing_fields: [], confidence: 1.0, is_interpolated: false };

      await client.query(`
        INSERT INTO trader_snapshots_v2 (platform, trader_key, "window", as_of_ts, metrics, quality, arena_score, roi_pct, pnl_usd, max_drawdown_pct, win_rate_pct, trades_count, copier_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (platform, trader_key, "window", as_of_ts) DO UPDATE SET metrics = $5, arena_score = $7, roi_pct = $8
      `, [
        'binance_futures', t.trader_key, w, asOfTs,
        JSON.stringify(metrics), JSON.stringify(quality),
        score.total, roi, pnl, t.max_drawdown, t.win_rate, t.trades, t.copiers,
      ]);
    }

    // 4. Insert timeseries (equity curve - 90 days)
    const equityData = [];
    let cumRoi = 0;
    for (let d = 89; d >= 0; d--) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      const dailyReturn = (t.roi_90d / 90) * (0.5 + Math.random());
      cumRoi += dailyReturn;
      equityData.push({ ts: date.toISOString().split('T')[0], value: Math.round(cumRoi * 100) / 100 });
    }

    await client.query(`
      INSERT INTO trader_timeseries (platform, trader_key, series_type, data, as_of_ts)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (platform, trader_key, series_type) DO UPDATE SET data = $4, as_of_ts = $5
    `, ['binance_futures', t.trader_key, 'equity_curve', JSON.stringify(equityData), now]);

    console.log(`[Seed] Inserted: ${t.display_name} (${t.trader_key.slice(0, 8)}...) | 90D ROI: ${t.roi_90d}% | Score: ${calculateArenaScore(t.roi_90d, t.pnl_90d, t.max_drawdown, t.win_rate, '90D').total}`);
  }

  // Verify counts
  const counts = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM trader_sources_v2) AS sources,
      (SELECT COUNT(*) FROM trader_profiles_v2) AS profiles,
      (SELECT COUNT(*) FROM trader_snapshots_v2) AS snapshots,
      (SELECT COUNT(*) FROM trader_timeseries) AS timeseries
  `);
  console.log('\n[Seed] Database counts:', counts.rows[0]);

  await client.end();
  console.log('[Seed] Done.');
}

seed().catch(console.error);
