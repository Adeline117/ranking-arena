#!/usr/bin/env node
/**
 * refetch-real-avatars.mjs — Replace DiceBear avatars with real platform avatars
 *
 * For each trader with a DiceBear avatar on a CEX platform,
 * calls the platform's fetchTraderProfile API to get the real avatar URL.
 *
 * Usage: node scripts/refetch-real-avatars.mjs [--dry-run] [--source=xxx] [--limit=N] [--concurrency=N]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DRY_RUN = process.argv.includes('--dry-run');
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null;
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0;
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '3') || 3;

// ── Platform API configs ──────────────────────────────────────────

const PLATFORM_APIS = {
  binance_futures: {
    fetchAvatar: async (traderId) => {
      const resp = await fetchJSON('https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com' },
        body: JSON.stringify({ portfolioId: traderId }),
      });
      return resp?.data?.userPhotoUrl || null;
    },
    delay: [2000, 4000],
  },
  bybit: {
    fetchAvatar: async (traderId) => {
      const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader/detail?leaderMark=${encodeURIComponent(traderId)}`;
      const resp = await fetchJSON(url, {
        headers: {
          'Origin': 'https://www.bybit.com',
          'Referer': `https://www.bybit.com/copyTrading/trade-center/detail?leaderMark=${encodeURIComponent(traderId)}`,
        },
      });
      return resp?.result?.avatar || null;
    },
    delay: [1500, 3000],
  },
  mexc: {
    fetchAvatar: async (traderId) => {
      const url = `https://futures.mexc.com/api/platform/copy-trade/trader/detail?traderId=${traderId}`;
      const resp = await fetchJSON(url, {
        headers: { 'Origin': 'https://futures.mexc.com' },
      });
      return resp?.data?.avatar || null;
    },
    delay: [1500, 3000],
  },
  kucoin: {
    fetchAvatar: async (traderId) => {
      const url = `https://www.kucoin.com/_api/copy-trade/leader/detail?leaderId=${traderId}`;
      const resp = await fetchJSON(url, {
        headers: { 'Origin': 'https://www.kucoin.com' },
      });
      return resp?.data?.avatar || null;
    },
    delay: [1500, 3000],
  },
  coinex: {
    fetchAvatar: async (traderId) => {
      const url = `https://www.coinex.com/res/copy-trading/trader/${traderId}`;
      const resp = await fetchJSON(url, {
        headers: { 'Origin': 'https://www.coinex.com' },
      });
      return resp?.data?.avatar || null;
    },
    delay: [1500, 3000],
  },
  binance_web3: {
    fetchAvatar: async (traderId) => {
      // Binance Web3 uses a different API
      const resp = await fetchJSON('https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.binance.com' },
        body: JSON.stringify({ portfolioId: traderId }),
      });
      return resp?.data?.userPhotoUrl || null;
    },
    delay: [2000, 4000],
  },
};

// ── Helpers ──────────────────────────────────────────

async function fetchJSON(url, options = {}) {
  try {
    const resp = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(range) {
  return range[0] + Math.random() * (range[1] - range[0]);
}

// ── Main ──────────────────────────────────────────

async function fetchDiceBearTraders(source) {
  const PAGE_SIZE = 1000;
  let all = [];
  let from = 0;

  while (true) {
    const to = LIMIT > 0 ? Math.min(from + PAGE_SIZE - 1, from + (LIMIT - all.length) - 1) : from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('trader_sources')
      .select('id, source, source_trader_id, handle')
      .eq('source', source)
      .like('avatar_url', '%dicebear%')
      .range(from, to);

    if (error) { console.error(`  ❌ Error: ${error.message}`); break; }
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < PAGE_SIZE || (LIMIT > 0 && all.length >= LIMIT)) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function processSource(source) {
  const config = PLATFORM_APIS[source];
  if (!config) {
    console.log(`⏭️  ${source}: no API config, skipping`);
    return { source, total: 0, updated: 0, failed: 0, noAvatar: 0 };
  }

  const traders = await fetchDiceBearTraders(source);
  if (!traders.length) {
    console.log(`✅ ${source}: no DiceBear avatars to replace`);
    return { source, total: 0, updated: 0, failed: 0, noAvatar: 0 };
  }

  console.log(`\n🔄 ${source}: ${traders.length} traders with DiceBear avatars`);

  let updated = 0, failed = 0, noAvatar = 0;

  for (let i = 0; i < traders.length; i++) {
    const t = traders[i];
    const progress = `[${i + 1}/${traders.length}]`;

    try {
      const realAvatar = await config.fetchAvatar(t.source_trader_id);

      if (realAvatar && !realAvatar.includes('dicebear') && !realAvatar.includes('default')) {
        if (!DRY_RUN) {
          const { error } = await supabase
            .from('trader_sources')
            .update({ avatar_url: realAvatar })
            .eq('id', t.id);

          if (error) {
            console.log(`  ${progress} ❌ ${t.handle || t.source_trader_id}: DB error - ${error.message}`);
            failed++;
          } else {
            console.log(`  ${progress} ✅ ${t.handle || t.source_trader_id}: ${realAvatar.substring(0, 60)}...`);
            updated++;
          }
        } else {
          console.log(`  ${progress} [DRY] ${t.handle || t.source_trader_id}: ${realAvatar.substring(0, 60)}...`);
          updated++;
        }
      } else {
        // API returned null or default avatar — platform genuinely has no avatar
        noAvatar++;
        if (i < 5 || i % 50 === 0) {
          console.log(`  ${progress} ⚪ ${t.handle || t.source_trader_id}: no real avatar on platform`);
        }
      }
    } catch (err) {
      console.log(`  ${progress} ❌ ${t.handle || t.source_trader_id}: ${err.message}`);
      failed++;
    }

    // Rate limit
    await sleep(randomDelay(config.delay));
  }

  console.log(`\n📊 ${source}: updated=${updated}, noAvatar=${noAvatar}, failed=${failed}`);
  return { source, total: traders.length, updated, failed, noAvatar };
}

async function main() {
  console.log(`\n🖼️  Real Avatar Fetcher ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`Sources: ${SOURCE_FILTER || 'all CEX platforms'}\n`);

  const sources = SOURCE_FILTER
    ? [SOURCE_FILTER]
    : Object.keys(PLATFORM_APIS);

  const results = [];
  for (const source of sources) {
    results.push(await processSource(source));
  }

  console.log('\n═══════════════════════════════════');
  console.log('SUMMARY:');
  let totalUpdated = 0, totalNoAvatar = 0, totalFailed = 0;
  for (const r of results) {
    if (r.total > 0) {
      console.log(`  ${r.source}: ${r.updated}/${r.total} updated, ${r.noAvatar} no avatar, ${r.failed} failed`);
      totalUpdated += r.updated;
      totalNoAvatar += r.noAvatar;
      totalFailed += r.failed;
    }
  }
  console.log(`\n  TOTAL: ${totalUpdated} updated, ${totalNoAvatar} no avatar, ${totalFailed} failed`);
  console.log('═══════════════════════════════════\n');
}

main().catch(console.error);
