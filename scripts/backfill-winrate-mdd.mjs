#!/usr/bin/env node
/**
 * backfill-winrate-mdd.mjs — Backfill win_rate and max_drawdown for multiple exchanges
 * 
 * Usage: node scripts/backfill-winrate-mdd.mjs --source=kucoin [--dry-run] [--limit=N] [--delay=MS]
 */

import { ProxyAgent } from 'undici';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROXY = process.env.HTTPS_PROXY || 'http://localhost:7890';
const DRY_RUN = process.argv.includes('--dry-run');
const SOURCE = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || 'kucoin';
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '9999');
const DELAY_MS = parseInt(process.argv.find(a => a.startsWith('--delay='))?.split('=')[1] || '3000');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const proxyAgent = new ProxyAgent(PROXY);

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
};

async function sbFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, { headers: { ...sbHeaders, ...opts.headers }, ...opts });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res;
}

async function getTradersMissing(source) {
  const filter = `source=eq.${source}&or=(win_rate.is.null,max_drawdown.is.null)`;
  const res = await sbFetch(`trader_snapshots?${filter}&select=id,source_trader_id,win_rate,max_drawdown`);
  const data = await res.json();
  
  const grouped = new Map();
  for (const row of data) {
    if (!grouped.has(row.source_trader_id)) {
      grouped.set(row.source_trader_id, { ids: [], needWR: false, needMDD: false });
    }
    const g = grouped.get(row.source_trader_id);
    g.ids.push(row.id);
    if (row.win_rate === null) g.needWR = true;
    if (row.max_drawdown === null) g.needMDD = true;
  }
  
  return [...grouped.entries()].slice(0, LIMIT);
}

async function updateSnapshots(ids, updates) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update ${ids.length} snapshots:`, updates);
    return;
  }
  // Batch: update where id in (...)
  const idFilter = ids.map(id => `id.eq.${id}`).join(',');
  await sbFetch(`trader_snapshots?or=(${idFilter})`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function proxyFetch(url, opts = {}) {
  const res = await fetch(url, {
    dispatcher: proxyAgent,
    method: opts.method || 'GET',
    body: opts.body,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// =========================================================
// KuCoin
// =========================================================
async function fetchKucoin(traderId) {
  const base = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow';
  const h = { 'Origin': 'https://www.kucoin.com', 'Referer': `https://www.kucoin.com/copytrading/trader-profile/${traderId}` };
  
  let winRate = null, maxDrawdown = null;
  
  // Win rate from position history
  try {
    const res = await proxyFetch(`${base}/positionHistory?lang=en_US&leadConfigId=${traderId}&period=30d`, { headers: h });
    if (res.success && res.data?.length > 0) {
      const wins = res.data.filter(p => parseFloat(p.closePnl) > 0).length;
      winRate = Math.round((wins / res.data.length) * 10000) / 100;
    }
  } catch (e) { console.warn(`  positionHistory: ${e.message}`); }
  
  // MDD from PNL history
  try {
    const res = await proxyFetch(`${base}/pnl/history?lang=en_US&leadConfigId=${traderId}&period=30d`, { headers: h });
    if (res.success && res.data?.length > 0) {
      const ratios = res.data.map(d => parseFloat(d.ratio));
      maxDrawdown = computeMDDFromRatios(ratios);
    }
  } catch (e) { console.warn(`  pnl/history: ${e.message}`); }
  
  return { winRate, maxDrawdown };
}

// =========================================================
// dYdX
// =========================================================
async function fetchDydx(traderId) {
  const h = { 'Origin': 'https://dydx.exchange', 'Referer': 'https://dydx.exchange/' };
  let winRate = null, maxDrawdown = null;
  
  // MDD from historical PnL
  try {
    const res = await proxyFetch(
      `https://indexer.dydx.trade/v4/historical-pnl?address=${traderId}&subaccountNumber=0&limit=90`, { headers: h }
    );
    if (res?.historicalPnl?.length > 0) {
      const equities = res.historicalPnl.map(d => parseFloat(d.equity)).reverse();
      maxDrawdown = computeMDDFromEquity(equities);
      
      // Compute win_rate from daily PnL changes
      const pnls = res.historicalPnl.reverse();
      let wins = 0, total = 0;
      for (let i = 1; i < pnls.length; i++) {
        const pnlChange = parseFloat(pnls[i].totalPnl) - parseFloat(pnls[i-1].totalPnl);
        if (pnlChange !== 0) {
          total++;
          if (pnlChange > 0) wins++;
        }
      }
      if (total > 0) winRate = Math.round((wins / total) * 10000) / 100;
    }
  } catch (e) { console.warn(`  dydx historical-pnl: ${e.message}`); }
  
  return { winRate, maxDrawdown };
}

// =========================================================
// Bybit
// =========================================================
async function fetchBybit(traderId) {
  const h = { 'Origin': 'https://www.bybit.com', 'Referer': 'https://www.bybit.com/copyTrading/trade-center/detail' };
  let winRate = null, maxDrawdown = null;
  
  try {
    const res = await proxyFetch(
      `https://api2.bybit.com/fapi/beehive/public/v1/common/leader/detail?leaderMark=${encodeURIComponent(traderId)}`, { headers: h }
    );
    if (res?.result) {
      const r = res.result;
      if (r.winRate !== undefined) winRate = parseFloat(r.winRate);
      if (r.maxDrawdown !== undefined) maxDrawdown = Math.abs(parseFloat(r.maxDrawdown));
    }
  } catch (e) { console.warn(`  bybit detail: ${e.message}`); }
  
  return { winRate, maxDrawdown };
}

// =========================================================
// Bitget Futures
// =========================================================
async function fetchBitget(traderId) {
  const h = {
    'Origin': 'https://www.bitget.com',
    'Referer': `https://www.bitget.com/copy-trading/trader/detail/${traderId}`,
    'Content-Type': 'application/json',
    'language': 'en_US',
  };
  let winRate = null, maxDrawdown = null;
  
  try {
    const res = await proxyFetch('https://www.bitget.com/v1/trigger/trace/queryTraderPerformance', {
      method: 'POST',
      body: JSON.stringify({ traderId, periodType: '30D' }),
      headers: h,
    });
    if (res?.data) {
      if (res.data.winRate !== undefined) winRate = parseFloat(res.data.winRate);
      if (res.data.maxDrawdown !== undefined) maxDrawdown = Math.abs(parseFloat(res.data.maxDrawdown));
    }
  } catch (e) { console.warn(`  bitget perf: ${e.message}`); }
  
  return { winRate, maxDrawdown };
}

// =========================================================
// Binance Spot
// =========================================================
async function fetchBinanceSpot(traderId) {
  const h = {
    'Origin': 'https://www.binance.com',
    'Referer': `https://www.binance.com/en/copy-trading/lead-details/${traderId}?type=spot`,
    'Content-Type': 'application/json',
  };
  let winRate = null, maxDrawdown = null;
  
  // Try new spot-copy-trade endpoint
  try {
    const res = await proxyFetch('https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/lead-portfolio/performance', {
      method: 'POST',
      body: JSON.stringify({ portfolioId: traderId, timeRange: 'MONTHLY' }),
      headers: h,
    });
    if (res?.data) {
      if (res.data.winRate !== undefined) winRate = parseFloat(res.data.winRate) * 100;
      if (res.data.maxDrawdown !== undefined) maxDrawdown = Math.abs(parseFloat(res.data.maxDrawdown) * 100);
      if (res.data.mdd !== undefined) maxDrawdown = Math.abs(parseFloat(res.data.mdd) * 100);
    }
  } catch (e) {
    // Try old endpoint
    try {
      const res = await proxyFetch('https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance', {
        method: 'POST',
        body: JSON.stringify({ portfolioId: traderId, timeRange: 'MONTHLY', portfolioType: 'SPOT' }),
        headers: h,
      });
      if (res?.data) {
        if (res.data.winRate !== undefined) winRate = parseFloat(res.data.winRate) * 100;
        if (res.data.maxDrawdown !== undefined) maxDrawdown = Math.abs(parseFloat(res.data.maxDrawdown) * 100);
      }
    } catch (e2) { console.warn(`  binance spot: ${e2.message}`); }
  }
  
  return { winRate, maxDrawdown };
}

// =========================================================
// MDD helpers
// =========================================================
function computeMDDFromRatios(ratios) {
  // ratios = cumulative return (e.g., 0.3 = 30% return)
  let peak = -Infinity, maxDD = 0;
  for (const r of ratios) {
    if (r > peak) peak = r;
    const dd = peak - r;
    if (dd > maxDD) maxDD = dd;
  }
  // Convert to percentage: if peak was 0.3 (30%) and dropped to 0.1 (10%), MDD = 20% of initial
  return Math.round(maxDD * 10000) / 100;
}

function computeMDDFromEquity(equities) {
  let peak = -Infinity, maxDD = 0;
  for (const eq of equities) {
    if (eq > peak) peak = eq;
    if (peak > 0) {
      const dd = (peak - eq) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return Math.round(maxDD * 10000) / 100;
}

// =========================================================
// Main
// =========================================================
const FETCHERS = {
  kucoin: fetchKucoin,
  bybit: fetchBybit,
  bitget_futures: fetchBitget,
  binance_spot: fetchBinanceSpot,
  dydx: fetchDydx,
};

async function main() {
  console.log(`Backfilling ${SOURCE} | dry_run=${DRY_RUN} | limit=${LIMIT} | delay=${DELAY_MS}ms`);
  
  const fetcher = FETCHERS[SOURCE];
  if (!fetcher) {
    console.error(`No fetcher for: ${SOURCE}. Available: ${Object.keys(FETCHERS).join(', ')}`);
    process.exit(1);
  }
  
  const traders = await getTradersMissing(SOURCE);
  console.log(`Found ${traders.length} traders needing backfill`);
  
  let updated = 0, skipped = 0, errors = 0;
  
  for (const [traderId, info] of traders) {
    try {
      const { winRate, maxDrawdown } = await fetcher(traderId);
      
      const updates = {};
      if (winRate !== null && winRate !== undefined && info.needWR) updates.win_rate = winRate;
      if (maxDrawdown !== null && maxDrawdown !== undefined && info.needMDD) updates.max_drawdown = maxDrawdown;
      
      if (Object.keys(updates).length > 0) {
        await updateSnapshots(info.ids, updates);
        updated++;
        console.log(`✅ ${traderId}: ${JSON.stringify(updates)} (${info.ids.length} rows)`);
      } else {
        skipped++;
        if (updated + skipped + errors <= 20 || (updated + skipped + errors) % 50 === 0) {
          console.log(`⏭️  ${traderId}: no data`);
        }
      }
    } catch (e) {
      errors++;
      console.error(`❌ ${traderId}: ${e.message}`);
    }
    
    await sleep(DELAY_MS);
  }
  
  console.log(`\nDone: ${updated} updated, ${skipped} skipped, ${errors} errors`);
}

main().catch(e => { console.error(e); process.exit(1); });
