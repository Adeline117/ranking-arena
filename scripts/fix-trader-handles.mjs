#!/usr/bin/env node
/**
 * Fix trader display names - fetch real usernames from exchange APIs
 * for traders whose handles are just numeric IDs or placeholder names.
 * 
 * Usage: node scripts/fix-trader-handles.mjs [--source mexc|xt|kucoin|coinex|bitget_futures|binance_futures] [--dry-run] [--proxy]
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const USE_PROXY = args.includes('--proxy');
const SOURCE_FILTER = args.find((a, i) => args[i-1] === '--source') || null;

const PROXY_URL = 'http://127.0.0.1:7890';

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJSON(url, options = {}) {
  const headers = {
    'User-Agent': randomUA(),
    'Accept': 'application/json',
    ...options.headers,
  };
  
  const fetchOpts = { ...options, headers };
  
  // Note: Node.js native fetch doesn't support HTTP proxy directly.
  // For proxy support, we'd need undici ProxyAgent or similar.
  // For now, direct fetch. If geo-blocked exchanges need proxy, run from VPS.
  
  const res = await fetch(url, fetchOpts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function postJSON(url, body, extraHeaders = {}) {
  return fetchJSON(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

// ============ Exchange-specific fetchers ============

const FETCHERS = {
  async mexc(trader) {
    const url = `https://www.mexc.com/api/platform/copy-trade/trader/detail?traderId=${trader.source_trader_id}`;
    const res = await fetchJSON(url, {
      headers: { 'Origin': 'https://www.mexc.com', 'Referer': 'https://www.mexc.com/copy-trading' },
    });
    const name = res?.data?.nickName;
    const avatar = res?.data?.avatar;
    return { display_name: name || null, avatar_url: avatar || null };
  },

  async xt(trader) {
    // XT copy trading API - try their public API
    const url = `https://www.xt.com/copytrade/api/v1/public/trader/detail?traderId=${trader.source_trader_id}`;
    const res = await fetchJSON(url, {
      headers: { 'Origin': 'https://www.xt.com', 'Referer': 'https://www.xt.com/en/copy-trading' },
    });
    const name = res?.data?.nickName || res?.data?.nickname || res?.data?.traderName;
    const avatar = res?.data?.avatar || res?.data?.avatarUrl;
    return { display_name: name || null, avatar_url: avatar || null };
  },

  async kucoin(trader) {
    const url = `https://www.kucoin.com/_api/copy-trade/leader/detail?leaderId=${trader.source_trader_id}`;
    const res = await fetchJSON(url, {
      headers: { 'Origin': 'https://www.kucoin.com' },
    });
    const name = res?.data?.nickName;
    const avatar = res?.data?.avatar;
    return { display_name: name || null, avatar_url: avatar || null };
  },

  async coinex(trader) {
    const url = `https://www.coinex.com/res/copy-trading/trader/${trader.source_trader_id}`;
    const res = await fetchJSON(url, {
      headers: { 'Origin': 'https://www.coinex.com' },
    });
    const name = res?.data?.nick_name;
    const avatar = res?.data?.avatar;
    return { display_name: name || null, avatar_url: avatar || null };
  },

  async bitget_futures(trader) {
    const url = 'https://www.bitget.com/v1/trigger/trace/queryTraderDetail';
    const res = await postJSON(url, { traderId: trader.source_trader_id }, {
      'Origin': 'https://www.bitget.com',
      'Referer': `https://www.bitget.com/copy-trading/trader/detail/${trader.source_trader_id}`,
    });
    const name = res?.data?.nickName || res?.data?.traderName;
    const avatar = res?.data?.headUrl;
    return { display_name: name || null, avatar_url: avatar || null };
  },

  async binance_futures(trader) {
    const url = 'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail';
    const res = await postJSON(url, { portfolioId: trader.source_trader_id }, {
      'Origin': 'https://www.binance.com',
      'Referer': 'https://www.binance.com/en/copy-trading',
    });
    const name = res?.data?.nickname;
    const avatar = res?.data?.userPhotoUrl;
    return { display_name: name || null, avatar_url: avatar || null };
  },

  async bingx(trader) {
    // BingX copy trading API
    const url = `https://bingx.com/api/copytrading/v1/trader/detail?traderId=${trader.source_trader_id}`;
    const res = await fetchJSON(url, {
      headers: { 'Origin': 'https://bingx.com', 'Referer': 'https://bingx.com/copy-trading/' },
    });
    const name = res?.data?.nickName || res?.data?.nickname;
    const avatar = res?.data?.avatar;
    return { display_name: name || null, avatar_url: avatar || null };
  },
};

// ============ Identify bad handles ============

function isBadHandle(trader) {
  const h = trader.handle;
  if (!h) return true;
  if (h === trader.source_trader_id) return true;
  if (/^(XT|MEXC|CoinEx|KuCoin|Binance|BingX) Trader \w+$/i.test(h)) return true;
  if (/^Mexctrader-/.test(h)) return true;
  if (/^中台未注册/.test(h)) return true;
  if (/^@BGUSER-/.test(h)) return true;
  if (/^\*+\d+$/.test(h)) return true; // BingX masked like *******277
  if (/^bingx_/.test(trader.source_trader_id) && /\*/.test(h)) return true;
  return false;
}

// ============ Main ============

async function getBadTraders(source) {
  const allTraders = [];
  let from = 0;
  const batchSize = 1000;
  
  while (true) {
    let query = supabase.from('trader_sources')
      .select('id, source, source_trader_id, handle, avatar_url')
      .eq('source', source)
      .range(from, from + batchSize - 1);
    
    const { data, error } = await query;
    if (error) { console.error('DB error:', error.message); break; }
    if (!data || data.length === 0) break;
    
    for (const t of data) {
      if (isBadHandle(t)) allTraders.push(t);
    }
    
    from += batchSize;
    if (data.length < batchSize) break;
  }
  
  return allTraders;
}

async function processSource(source) {
  const fetcher = FETCHERS[source];
  if (!fetcher) {
    console.log(`⚠️  No fetcher for ${source}, skipping`);
    return { source, total: 0, updated: 0, failed: 0, skipped: 0 };
  }

  console.log(`\n🔍 Finding bad handles for ${source}...`);
  const traders = await getBadTraders(source);
  console.log(`   Found ${traders.length} traders to fix`);

  if (traders.length === 0) return { source, total: 0, updated: 0, failed: 0, skipped: 0 };

  let updated = 0, failed = 0, skipped = 0;
  const DELAY = source === 'mexc' ? 2000 : source === 'xt' ? 3000 : 2000;

  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i];
    
    try {
      const result = await fetcher(trader);
      
      if (!result.display_name || result.display_name === trader.handle) {
        skipped++;
        if (i % 50 === 0) process.stdout.write(`  [${i}/${traders.length}] skipped\r`);
        await sleep(500);
        continue;
      }

      const updateData = { handle: result.display_name };
      if (result.avatar_url && !trader.avatar_url) {
        updateData.avatar_url = result.avatar_url;
      }

      if (DRY_RUN) {
        console.log(`  [DRY] ${trader.handle} → ${result.display_name}`);
        updated++;
      } else {
        const { error } = await supabase.from('trader_sources')
          .update(updateData)
          .eq('id', trader.id);
        
        if (error) {
          console.error(`  ❌ DB update failed for ${trader.id}: ${error.message}`);
          failed++;
        } else {
          updated++;
          if (updated % 10 === 0 || updated <= 5) {
            console.log(`  ✅ [${i+1}/${traders.length}] ${trader.handle} → ${result.display_name}`);
          }
        }
      }
    } catch (err) {
      failed++;
      if (failed <= 5) console.error(`  ❌ ${source}/${trader.source_trader_id}: ${err.message}`);
      if (failed > 20 && failed > updated * 2) {
        console.error(`  🛑 Too many failures for ${source}, stopping`);
        break;
      }
    }

    await sleep(DELAY + Math.random() * 1000);
  }

  return { source, total: traders.length, updated, failed, skipped };
}

async function main() {
  console.log('🚀 Fix Trader Handles Script');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`   Proxy: ${USE_PROXY ? PROXY_URL : 'disabled'}`);
  
  const sources = SOURCE_FILTER 
    ? [SOURCE_FILTER]
    : ['binance_futures', 'mexc', 'xt', 'kucoin', 'coinex', 'bitget_futures', 'bingx'];

  const results = [];
  for (const source of sources) {
    const result = await processSource(source);
    results.push(result);
    console.log(`\n📊 ${source}: ${result.updated} updated, ${result.failed} failed, ${result.skipped} skipped / ${result.total} total`);
  }

  console.log('\n========== Summary ==========');
  let totalUpdated = 0, totalFailed = 0;
  for (const r of results) {
    console.log(`  ${r.source}: ${r.updated}/${r.total} updated, ${r.failed} failed`);
    totalUpdated += r.updated;
    totalFailed += r.failed;
  }
  console.log(`  TOTAL: ${totalUpdated} updated, ${totalFailed} failed`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
