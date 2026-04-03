/**
 * 统一导入脚本 - 所有平台 (Robust版本)
 * 改进: 更强的错误容忍、重试机制、失败页面跳过
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SCRAPER = process.env.VPS_SCRAPER_HOST || 'http://45.76.152.169:3457';
const API_KEY = 'arena-proxy-sg-2026';
const TIMEOUT = 300000; // 5 minutes

function parseNumber(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[+%,]/g, '')) || 0;
}

function score(roi, pnl, mdd, wr) {
  const r = Math.min((roi || 0) * 10, 100) * 1.2;
  const p = pnl ? Math.min(Math.log10(Math.abs(pnl) + 1) * 15, 50) : 0;
  const m = mdd ? Math.abs(mdd) * 0.3 : 0;
  const w = wr ? (wr - 50) * 0.2 : 0;
  return Math.max(0, r + p - m + w);
}

/**
 * Robust fetch with exponential backoff retry
 */
async function fetchAPI(endpoint, params = {}, maxRetries = 3) {
  const url = new URL(endpoint, SCRAPER);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);
    
    try {
      const res = await fetch(url.toString(), {
        headers: { 'x-proxy-key': API_KEY },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      // Success
      if (res.ok) return res.json();
      
      // Server error - retry with backoff
      if (res.status >= 500 && attempt < maxRetries) {
        const delay = Math.min(10000 * Math.pow(2, attempt), 60000); // 10s, 20s, 40s, max 60s
        console.log(`  HTTP ${res.status}, retry ${attempt + 1}/${maxRetries} in ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      // Client error or max retries reached
      throw new Error(`HTTP ${res.status}`);
      
    } catch (e) {
      if (attempt === maxRetries) throw e;
      
      const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
      console.log(`  Error: ${e.message}, retry ${attempt + 1}/${maxRetries} in ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Platform parsers (same as before)
const PLATFORMS = {
  bybit: {
    endpoint: '/bybit/leaderboard',
    params: { pageNo: 1, pageSize: 100 },
    parse: (data) => {
      if (!data.result?.leaderDetails) return [];
      return data.result.leaderDetails.map(t => {
        const m = t.metricValues || [];
        const roi = parseNumber(m[0]);
        const mdd = parseNumber(m[1]);
        const wr = parseNumber(m[3]);
        return {
          source: 'bybit',
          source_trader_id: t.leaderUserId,
          handle: t.nickName || 'Unknown',
          avatar_url: t.profilePhoto,
          roi, win_rate: wr, pnl: 0, trade_count: 0,
          followers_count: parseInt(t.currentFollowerCount || 0),
          arena_score: score(roi, 0, mdd, wr)
        };
      });
    }
  },
  
  bitget: {
    endpoint: '/bitget/leaderboard',
    params: { pageNo: 1, pageSize: 100, period: 'THIRTY_DAYS', type: 'futures' },
    parse: (data) => {
      if (data.code !== '00000' || !data.data?.traderList) return [];
      return data.data.traderList.map(t => {
        const roi = parseNumber(t.profitRate);
        const pnl = parseNumber(t.totalProfit);
        const wr = parseNumber(t.winRate);
        const mdd = parseNumber(t.maxDrawdown);
        return {
          source: 'bitget_futures',
          source_trader_id: String(t.traderUid),
          handle: t.nickName || 'Unknown',
          avatar_url: t.headUrl,
          roi, pnl, win_rate: wr, trade_count: 0,
          followers_count: parseInt(t.followerCount || 0),
          arena_score: score(roi, pnl, mdd, wr)
        };
      });
    }
  },
  
  mexc: {
    endpoint: '/mexc/leaderboard',
    params: { pageNum: 1, pageSize: 100, dateType: '30' },
    parse: (data) => {
      const inner = data.data || data;
      const traders = [
        ...(inner.goldTraders || []),
        ...(inner.silverTraders || []),
        ...(inner.comprehensives || []),
        ...(inner.items || [])
      ];
      if (traders.length === 0) return [];
      return traders.map(t => {
        const roi = parseNumber(t.roi);
        const pnl = parseNumber(t.pnl || t.totalProfit || t.totalPnl);
        const wr = parseNumber(t.winRate);
        const mdd = parseNumber(t.maxDrawdown7 || t.maxDrawdown);
        return {
          source: 'mexc',
          source_trader_id: String(t.uid || t.traderId),
          handle: t.nickname || t.nickName || 'Unknown',
          avatar_url: t.avatar,
          roi, pnl, win_rate: wr, trade_count: 0,
          followers_count: parseInt(t.followers || t.followerNum || 0),
          arena_score: score(roi, pnl, mdd, wr)
        };
      });
    }
  },
};

async function importPlatform(platformName, config) {
  console.log(`\n=== ${platformName.toUpperCase()} ===`);
  
  const allTraders = [];
  const TARGET = 500;
  const MAX_PAGES = 25;
  let failedPages = 0;
  const MAX_FAILED_PAGES = 5; // Allow max 5 failed pages
  
  for (let page = 1; page <= MAX_PAGES; page++) {
    console.log(`Page ${page}...`);
    const start = Date.now();
    
    try {
      const params = { ...config.params };
      if (params.pageNo !== undefined) params.pageNo = page;
      if (params.pageNum !== undefined) params.pageNum = page;
      
      const data = await fetchAPI(config.endpoint, params, 3); // 3 retries
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      
      const traders = config.parse(data);
      if (traders.length === 0) {
        console.log(`  No data (${elapsed}s)`);
        break;
      }
      
      allTraders.push(...traders);
      console.log(`  +${traders.length} (total: ${allTraders.length}, ${elapsed}s)`);
      
      // Success - reset failed counter
      failedPages = 0;
      
      if (allTraders.length >= TARGET) {
        console.log(`  Target reached (${TARGET})`);
        break;
      }
      
      // Check has more
      let hasMore = false;
      if (data.data?.nextFlag === true) hasMore = true;
      else if (data.data?.goldTraders?.length > 0 || data.data?.silverTraders?.length > 0) hasMore = true;
      else if (data.result?.leaderDetails?.length >= 50) hasMore = true;
      
      if (!hasMore) {
        console.log(`  Last page reached`);
        break;
      }
      
      // Throttle
      if (page < 5 && page < MAX_PAGES) {
        console.log(`  Waiting 15s...`);
        await new Promise(r => setTimeout(r, 15000));
      }
      
    } catch (err) {
      failedPages++;
      console.log(`  ❌ Page ${page} failed: ${err.message} (failed: ${failedPages}/${MAX_FAILED_PAGES})`);
      
      // If too many consecutive failures, stop
      if (failedPages >= MAX_FAILED_PAGES) {
        console.log(`  ⚠️  Too many failed pages, stopping`);
        break;
      }
      
      // Otherwise continue to next page
      await new Promise(r => setTimeout(r, 5000)); // Wait 5s before next page
      continue;
    }
  }
  
  // Save to database
  if (allTraders.length === 0) {
    console.log(`❌ No data to save`);
    return 0;
  }
  
  // Check if we got enough data
  const successRate = (allTraders.length / TARGET) * 100;
  if (successRate < 80) {
    console.log(`⚠️  WARNING: Only got ${allTraders.length}/${TARGET} (${successRate.toFixed(1)}%)`);
  }
  
  console.log(`\nSaving ${allTraders.length} traders...`);
  
  const records = allTraders.map((t, i) => ({
    ...t,
    market_type: null,
    time_window: '30D',
    rank: i + 1,
    computed_at: new Date().toISOString()
  }));
  
  // Delete old
  const { error: delError } = await supabase
    .from('leaderboard_snapshots')
    .delete()
    .eq('source', records[0].source)
    .eq('time_window', '30D');
  
  if (delError) {
    console.log(`⚠️  Delete error: ${delError.message}`);
  }
  
  // Insert new
  let saved = 0;
  const batchSize = 50;
  
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    try {
      const { error } = await supabase
        .from('leaderboard_snapshots')
        .insert(batch);
      
      if (error) throw error;
      saved += batch.length;
    } catch (err) {
      console.log(`  ❌ Batch ${Math.floor(i/batchSize) + 1} failed: ${err.message}`);
    }
  }
  
  console.log(`✅ Saved: ${saved}/${allTraders.length}`);
  return saved;
}

async function main() {
  console.log('====================================');
  console.log('Multi-Platform Import (Robust)');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('====================================');
  
  const results = {};
  
  for (const [name, config] of Object.entries(PLATFORMS)) {
    try {
      results[name] = await importPlatform(name, config);
      
      console.log('\nWaiting 30s before next platform...\n');
      await new Promise(r => setTimeout(r, 30000));
    } catch (err) {
      console.error(`❌ ${name} failed:`, err.message);
      results[name] = 0;
    }
  }
  
  console.log('\n====================================');
  console.log('SUMMARY');
  console.log('====================================');
  let total = 0;
  for (const [name, count] of Object.entries(results)) {
    const status = count >= 400 ? '✅' : count >= 200 ? '⚠️' : '❌';
    console.log(`  ${status} ${name}: ${count}`);
    total += count;
  }
  console.log(`  TOTAL: ${total}`);
  console.log('====================================\n');
  
  // Exit with error if total < threshold
  if (total < 1000) {
    console.error(`⚠️  Total count too low (${total} < 1000)`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
