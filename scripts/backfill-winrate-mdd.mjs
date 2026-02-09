#!/usr/bin/env node
/**
 * backfill-winrate-mdd.mjs — Backfill win_rate and max_drawdown for multiple exchanges
 * 
 * Supports: kucoin, bybit, bitget_futures, binance_spot, dydx, coinex, aevo, bingx, phemex, weex, binance_web3
 * 
 * Usage: node scripts/backfill-winrate-mdd.mjs --source=kucoin [--dry-run] [--limit=N] [--delay=MS]
 */

import { HttpsProxyAgent } from 'https-proxy-agent';

const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROXY = process.env.HTTPS_PROXY || 'http://localhost:7890';
const DRY_RUN = process.argv.includes('--dry-run');
const SOURCE = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || 'kucoin';
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '9999');
const DELAY_MS = parseInt(process.argv.find(a => a.startsWith('--delay='))?.split('=')[1] || '3000');
const BACKFILL_MDD = !process.argv.includes('--no-mdd');
const BACKFILL_WR = !process.argv.includes('--no-wr');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const proxyAgent = new HttpsProxyAgent(PROXY);
const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
};

async function sbFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, { headers: { ...headers, ...opts.headers }, ...opts });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res;
}

async function getTradersMissing(source) {
  // Get traders missing win_rate or max_drawdown
  let filter = `source=eq.${source}`;
  if (BACKFILL_WR && BACKFILL_MDD) {
    filter += '&or=(win_rate.is.null,max_drawdown.is.null)';
  } else if (BACKFILL_WR) {
    filter += '&win_rate=is.null';
  } else if (BACKFILL_MDD) {
    filter += '&max_drawdown=is.null';
  }
  
  const res = await sbFetch(`trader_snapshots?${filter}&select=id,source_trader_id,win_rate,max_drawdown`);
  const data = await res.json();
  
  // Group by trader ID, collect snapshot IDs
  const grouped = new Map();
  for (const row of data) {
    if (!grouped.has(row.source_trader_id)) {
      grouped.set(row.source_trader_id, {
        ids: [],
        needWR: row.win_rate === null,
        needMDD: row.max_drawdown === null,
      });
    }
    grouped.get(row.source_trader_id).ids.push(row.id);
  }
  
  return [...grouped.entries()].slice(0, LIMIT);
}

async function updateSnapshots(ids, updates) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update ${ids.length} snapshots:`, updates);
    return;
  }
  
  // Batch update all snapshots for this trader
  for (const id of ids) {
    await sbFetch(`trader_snapshots?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithProxy(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    dispatcher: undefined, // not needed for node 18+ with proxy agent
    agent: proxyAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Origin': opts.origin || '',
      'Referer': opts.referer || '',
      ...opts.headers,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// =========================================================
// Exchange-specific fetchers
// =========================================================

// --- KuCoin ---
async function fetchKucoin(traderId) {
  const base = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow';
  const hdrs = { origin: 'https://www.kucoin.com', referer: `https://www.kucoin.com/copytrading/trader-profile/${traderId}` };
  
  let winRate = null, maxDrawdown = null;
  
  // Fetch position history for win_rate
  try {
    const posRes = await fetchWithProxy(`${base}/positionHistory?lang=en_US&leadConfigId=${traderId}&period=30d`, hdrs);
    if (posRes.success && posRes.data && posRes.data.length > 0) {
      const wins = posRes.data.filter(p => parseFloat(p.closePnl) > 0).length;
      const total = posRes.data.length;
      winRate = total > 0 ? Math.round((wins / total) * 10000) / 100 : null;
    }
  } catch (e) {
    console.warn(`  positionHistory failed: ${e.message}`);
  }
  
  // Fetch PNL history for max_drawdown
  try {
    const pnlRes = await fetchWithProxy(`${base}/pnl/history?lang=en_US&leadConfigId=${traderId}&period=30d`, hdrs);
    if (pnlRes.success && pnlRes.data && pnlRes.data.length > 0) {
      maxDrawdown = computeMDDFromRatios(pnlRes.data.map(d => parseFloat(d.ratio)));
    }
  } catch (e) {
    console.warn(`  pnl/history failed: ${e.message}`);
  }
  
  return { winRate, maxDrawdown };
}

// --- Bybit ---
async function fetchBybit(traderId) {
  const base = 'https://api2.bybit.com/fapi/beehive/public';
  const hdrs = { origin: 'https://www.bybit.com', referer: 'https://www.bybit.com/copyTrading/trade-center/detail' };
  
  let winRate = null, maxDrawdown = null;
  
  try {
    const detRes = await fetchWithProxy(`${base}/v1/common/leader/detail?leaderMark=${encodeURIComponent(traderId)}`, hdrs);
    if (detRes?.result) {
      winRate = parseFloat(detRes.result.winRate) || null;
      maxDrawdown = parseFloat(detRes.result.maxDrawdown) || null;
    }
  } catch (e) {
    console.warn(`  bybit detail failed: ${e.message}`);
  }
  
  return { winRate, maxDrawdown };
}

// --- Bitget Futures ---
async function fetchBitget(traderId) {
  const hdrs = {
    origin: 'https://www.bitget.com',
    referer: `https://www.bitget.com/copy-trading/trader/detail/${traderId}`,
    headers: { 'Content-Type': 'application/json', 'language': 'en_US' },
  };
  
  let winRate = null, maxDrawdown = null;
  
  try {
    const res = await fetchWithProxy('https://www.bitget.com/v1/trigger/trace/queryTraderPerformance', {
      method: 'POST',
      body: JSON.stringify({ traderId, periodType: '30D' }),
      ...hdrs,
    });
    if (res?.data) {
      winRate = parseFloat(res.data.winRate) || null;
      maxDrawdown = parseFloat(res.data.maxDrawdown) || null;
    }
  } catch (e) {
    console.warn(`  bitget performance failed: ${e.message}`);
  }
  
  return { winRate, maxDrawdown };
}

// --- Binance Spot ---
async function fetchBinanceSpot(traderId) {
  const hdrs = {
    origin: 'https://www.binance.com',
    referer: `https://www.binance.com/en/copy-trading/lead-details/${traderId}?type=spot`,
    headers: { 'Content-Type': 'application/json' },
  };
  
  let winRate = null, maxDrawdown = null;
  
  try {
    const res = await fetchWithProxy('https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance', {
      method: 'POST',
      body: JSON.stringify({ portfolioId: traderId, timeRange: 'MONTHLY', portfolioType: 'SPOT' }),
      ...hdrs,
    });
    if (res?.data) {
      winRate = parseFloat(res.data.winRate) || null;
      maxDrawdown = parseFloat(res.data.maxDrawdown) || null;
      // Binance may use mdd
      if (!maxDrawdown) maxDrawdown = parseFloat(res.data.mdd) || null;
    }
  } catch (e) {
    console.warn(`  binance spot performance failed: ${e.message}`);
  }
  
  return { winRate, maxDrawdown };
}

// --- dYdX ---
async function fetchDydx(traderId) {
  let winRate = null, maxDrawdown = null;
  
  try {
    // Fetch fills to compute win_rate from closed positions
    const fills = await fetchWithProxy(
      `https://indexer.dydx.trade/v4/fills?address=${traderId}&subaccountNumber=0&limit=100`,
      { origin: 'https://dydx.exchange', referer: 'https://dydx.exchange/' }
    );
    
    if (fills?.fills && fills.fills.length > 0) {
      // Group fills by position (market), compute PnL per closed position
      // This is complex - simplified: count fills with positive vs negative realized PnL
      // dYdX fills don't have closedPnl directly, need position-level calculation
      // Skip win_rate for dYdX - use transfers/PnL endpoint instead
    }
  } catch (e) {
    console.warn(`  dydx fills failed: ${e.message}`);
  }
  
  // Compute MDD from historical PnL
  try {
    const res = await fetchWithProxy(
      `https://indexer.dydx.trade/v4/historical-pnl?address=${traderId}&subaccountNumber=0&limit=90`,
      { origin: 'https://dydx.exchange', referer: 'https://dydx.exchange/' }
    );
    
    if (res?.historicalPnl && res.historicalPnl.length > 0) {
      const equities = res.historicalPnl.map(d => parseFloat(d.equity)).reverse();
      maxDrawdown = computeMDDFromEquity(equities);
    }
  } catch (e) {
    console.warn(`  dydx historical-pnl failed: ${e.message}`);
  }
  
  return { winRate, maxDrawdown };
}

// =========================================================
// MDD computation helpers
// =========================================================

function computeMDDFromRatios(ratios) {
  // ratios are cumulative return ratios (e.g., 0.30 = 30%)
  let peak = -Infinity;
  let maxDD = 0;
  
  for (const r of ratios) {
    if (r > peak) peak = r;
    const dd = peak - r;
    if (dd > maxDD) maxDD = dd;
  }
  
  // Return as percentage
  return peak > 0 ? Math.round(maxDD / (1 + peak) * 10000) / 100 : Math.round(maxDD * 10000) / 100;
}

function computeMDDFromEquity(equities) {
  let peak = -Infinity;
  let maxDD = 0;
  
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
    console.error(`No fetcher for source: ${SOURCE}. Available: ${Object.keys(FETCHERS).join(', ')}`);
    process.exit(1);
  }
  
  const traders = await getTradersMissing(SOURCE);
  console.log(`Found ${traders.length} traders needing backfill`);
  
  let updated = 0, skipped = 0, errors = 0;
  
  for (const [traderId, info] of traders) {
    try {
      const { winRate, maxDrawdown } = await fetcher(traderId);
      
      const updates = {};
      if (winRate !== null && info.needWR && BACKFILL_WR) updates.win_rate = winRate;
      if (maxDrawdown !== null && info.needMDD && BACKFILL_MDD) updates.max_drawdown = maxDrawdown;
      
      if (Object.keys(updates).length > 0) {
        await updateSnapshots(info.ids, updates);
        updated++;
        console.log(`✅ ${traderId}: ${JSON.stringify(updates)} (${info.ids.length} snapshots)`);
      } else {
        skipped++;
        console.log(`⏭️  ${traderId}: no data available`);
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
