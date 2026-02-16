import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const CHAIN_ID = 42161;
const DELAY = 250;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, timeout = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return res.json();
  } catch { clearTimeout(timer); return null; }
}

function calcMDD(trades) {
  // trades should be sorted by date asc
  // Build equity curve from cumulative pnl_net
  if (!trades.length) return null;
  let cumPnl = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trades) {
    if (t.pnl_net == null) continue;
    cumPnl += parseFloat(t.pnl_net);
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }
  // Return as percentage of peak (if peak > 0)
  if (peak <= 0) return maxDD > 0 ? -100 : 0;
  return -Math.round((maxDD / peak) * 10000) / 100;
}

async function main() {
  const client = await pool.connect();
  
  // Get all gains addresses needing any enrichment
  const { rows } = await client.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source = 'gains' 
      AND (win_rate IS NULL OR trades_count IS NULL OR max_drawdown IS NULL)
  `);
  console.log(`Total addresses needing enrichment: ${rows.length}`);
  
  let statsUpdated = 0, mddUpdated = 0, failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const addr = rows[i].source_trader_id;
    
    // Fetch stats (WR + TC)
    const stats = await fetchJSON(
      `https://backend-global.gains.trade/api/personal-trading-history/${addr}/stats?chainId=${CHAIN_ID}`
    );
    
    if (!stats || stats.error) {
      failed++;
      if ((i + 1) % 50 === 0) console.log(`${i + 1}/${rows.length} | stats: ${statsUpdated} | mdd: ${mddUpdated} | failed: ${failed}`);
      await sleep(DELAY);
      continue;
    }

    const updateFields = {};
    const winRate = parseFloat(stats.winRate);
    if (!isNaN(winRate)) updateFields.win_rate = Math.round(winRate * 10000) / 100; // Convert 0.xx to xx.xx%
    if (stats.totalTrades != null) updateFields.trades_count = parseInt(stats.totalTrades);

    // Fetch trade history for MDD
    const history = await fetchJSON(
      `https://backend-global.gains.trade/api/personal-trading-history/${addr}?chainId=${CHAIN_ID}`,
      15000
    );
    
    if (history?.data && Array.isArray(history.data)) {
      // Sort by date ascending
      const closeTrades = history.data
        .filter(t => t.action && !t.action.includes('Opened') && t.pnl_net != null)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      
      if (closeTrades.length > 0) {
        const mdd = calcMDD(closeTrades);
        if (mdd !== null) updateFields.max_drawdown = mdd;
      }
    }

    if (Object.keys(updateFields).length > 0) {
      // Build SET clause
      const sets = [];
      const vals = [];
      let idx = 1;
      for (const [k, v] of Object.entries(updateFields)) {
        sets.push(`${k} = $${idx}`);
        vals.push(v);
        idx++;
      }
      vals.push(addr);
      
      const result = await client.query(
        `UPDATE trader_snapshots SET ${sets.join(', ')} WHERE source = 'gains' AND source_trader_id = $${idx}`,
        vals
      );
      if (updateFields.win_rate != null || updateFields.trades_count != null) statsUpdated += result.rowCount;
      if (updateFields.max_drawdown != null) mddUpdated += result.rowCount;
    }

    if ((i + 1) % 50 === 0) console.log(`${i + 1}/${rows.length} | stats: ${statsUpdated} | mdd: ${mddUpdated} | failed: ${failed}`);
    await sleep(DELAY);
  }

  console.log(`\nDone! Stats updated: ${statsUpdated}, MDD updated: ${mddUpdated}, Failed: ${failed}`);

  // Verify
  const verify = await client.query(`
    SELECT 
      COUNT(*) FILTER (WHERE win_rate IS NULL) as wr_null,
      COUNT(*) FILTER (WHERE max_drawdown IS NULL) as mdd_null,
      COUNT(*) FILTER (WHERE trades_count IS NULL) as tc_null,
      COUNT(*) as total
    FROM trader_snapshots WHERE source = 'gains'
  `);
  console.log('Remaining gaps:', verify.rows[0]);

  client.release();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
