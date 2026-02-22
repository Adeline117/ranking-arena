#!/usr/bin/env node
/**
 * enrich-bybit-spot-tc.mjs
 * Fill NULL trades_count for bybit_spot leaderboard_ranks
 * 
 * bybit_spot source_trader_id = numeric userId (like "191585431")
 * 
 * Strategy:
 * 1. Open bybit spot copy trading page with puppeteer
 * 2. Intercept API responses to get trader data (including win/loss counts)
 * 3. Match by leaderUserId and update trades_count
 * 
 * The key: Bybit spot uses the same dynamic-leader-list API but the leaderUserId
 * is what we store as source_trader_id
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const SB_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';
const H = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal'
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`SB ${r.status}`);
  return r.json();
}

async function sbPatch(id, data) {
  const r = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?id=eq.${id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify(data)
  });
  if (!r.ok) console.error('Patch error', r.status);
}

async function main() {
  console.log('=== Bybit Spot Trades Count Enrichment ===\n');

  // 1. Get DB rows missing trades_count
  let allRows = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet(
      `leaderboard_ranks?source=eq.bybit_spot&trades_count=is.null&select=id,source_trader_id,season_id&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    allRows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`DB rows missing TC: ${allRows.length}`);
  if (!allRows.length) { console.log('Nothing to do.'); return; }

  // Build lookup: source_trader_id → [rows]
  const lookup = new Map();
  for (const r of allRows) {
    if (!lookup.has(r.source_trader_id)) lookup.set(r.source_trader_id, []);
    lookup.get(r.source_trader_id).push(r);
  }
  console.log(`Unique traders: ${lookup.size}`);

  // enrichMap: source_trader_id → { sevenDay: {wr, mdd, tc}, thirtyDay: ..., ninetyDay: ... }
  const enrichMap = new Map();

  // 2. Launch puppeteer
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Intercept responses
  const capturedApis = new Set();
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('bybit')) return;
    if (!url.includes('copy') && !url.includes('leader') && !url.includes('spot/api')) return;
    const key = url.split('?')[0];
    if (!capturedApis.has(key)) {
      capturedApis.add(key);
      console.log(`  New API: ${key.split('/').slice(-3).join('/')}`);
    }
    
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const data = await resp.json().catch(() => null);
      if (!data) return;
      
      // Look for trader list with leaderUserId
      const list = data?.result?.leaderDetails || data?.data?.list || data?.result?.list || [];
      for (const item of list) {
        const uid = String(item.leaderUserId || item.userId || item.uid || '');
        if (!uid) continue;
        
        // Extract TC from different fields
        const winCount = parseInt(item.winCount || '0');
        const loseCount = parseInt(item.loseCount || '0');
        const tc = winCount + loseCount > 0 ? (winCount + loseCount) : null;
        
        // Also from metricValues
        const metrics = item.metricValues || [];
        // Bybit: [ROI, drawdown, followerProfit, winRate, PLRatio, SharpeRatio]
        
        if (!enrichMap.has(uid)) enrichMap.set(uid, {});
        
        // Try to figure out which period this is from the request
        if (tc !== null) {
          enrichMap.get(uid).tc = tc;
        }
      }
    } catch { /* ignore */ }
  });

  // Navigate to Bybit and get cookies
  console.log('Loading Bybit...');
  try {
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log('  Nav note:', e.message.slice(0, 60));
  }
  await sleep(4000);

  // 3. Paginate via leader-list for spot copy trading
  const DURATIONS = [
    'DATA_DURATION_SEVEN_DAY',
    'DATA_DURATION_THIRTY_DAY',
    'DATA_DURATION_NINETY_DAY',
  ];
  const PERIOD_PREFIX = { 'DATA_DURATION_SEVEN_DAY': '7D', 'DATA_DURATION_THIRTY_DAY': '30D', 'DATA_DURATION_NINETY_DAY': '90D' };

  // Collect leaderUserId → leaderMark mapping and TC data
  const uidToMark = new Map();

  for (const dur of DURATIONS) {
    let pg = 1;
    let empty = 0;
    const season = PERIOD_PREFIX[dur];
    console.log(`\nFetching ${dur}...`);
    
    while (true) {
      const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pg}&pageSize=50&dataDuration=${dur}&sortField=LEADER_SORT_FIELD_SORT_ROI`;
      
      let json;
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (!text || text.startsWith('<')) { empty++; break; }
        json = JSON.parse(text);
      } catch { empty++; break; }
      
      if (json?.retCode !== 0) break;
      const items = json?.result?.leaderDetails || [];
      if (!items.length) { empty++; if (empty >= 2) break; pg++; continue; }
      empty = 0;

      for (const item of items) {
        const uid = String(item.leaderUserId || '');
        const mark = item.leaderMark || '';
        if (uid && mark) uidToMark.set(uid, mark);
        
        const winCount = parseInt(item.winCount || '0');
        const loseCount = parseInt(item.loseCount || '0');
        if (winCount + loseCount > 0) {
          if (!enrichMap.has(uid)) enrichMap.set(uid, {});
          enrichMap.get(uid)[season] = winCount + loseCount;
        }
      }

      if (pg % 20 === 0) {
        const matched = [...enrichMap.keys()].filter(uid => lookup.has(uid)).length;
        console.log(`  Page ${pg}: ${enrichMap.size} enriched, ${matched} DB matched`);
      }
      pg++;
      await sleep(200);
      if (pg > 200) break;
    }
  }

  // 4. For traders with leaderMark but no TC, try leader-income
  const missingTc = [...lookup.keys()].filter(uid => !enrichMap.has(uid) || !Object.values(enrichMap.get(uid)).some(v => v > 0));
  console.log(`\n${missingTc.length} traders still missing TC. Trying leader-income API...`);
  
  // Navigate back to Bybit for fresh cookies
  try {
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(3000);
  } catch {}

  let incomeGot = 0;
  for (let i = 0; i < missingTc.length; i++) {
    const uid = missingTc[i];
    const mark = uidToMark.get(uid);
    if (!mark) continue;

    const apiUrl = `/x-api/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(mark)}`;
    
    const result = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) return { error: r.status };
        return r.json();
      } catch (e) { return { error: e.message }; }
    }, apiUrl);

    if (result?.retCode === 0 && result?.result) {
      const r = result.result;
      const periods = {
        '7D': parseInt(r.sevenDayWinCount||0) + parseInt(r.sevenDayLossCount||0),
        '30D': parseInt(r.thirtyDayWinCount||0) + parseInt(r.thirtyDayLossCount||0),
        '90D': parseInt(r.ninetyDayWinCount||0) + parseInt(r.ninetyDayLossCount||0),
      };
      if (Object.values(periods).some(v => v > 0)) {
        enrichMap.set(uid, periods);
        incomeGot++;
      }
    }

    if (i % 30 === 0) console.log(`  Income API: ${i}/${missingTc.length}, got ${incomeGot}`);
    await sleep(200);
  }

  await browser.close();
  console.log(`\nTotal enrichMap: ${enrichMap.size}`);

  // 5. Update DB
  let updated = 0;
  for (const row of allRows) {
    const uid = row.source_trader_id;
    const data = enrichMap.get(uid);
    if (!data) continue;

    // Try to get TC for this season
    const tc = data[row.season_id] || data.tc || null;
    if (tc === null || tc === 0) continue;

    await sbPatch(row.id, { trades_count: tc });
    updated++;
  }

  console.log(`\n✅ Bybit Spot TC Results: ${updated} updated`);
  const vr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.bybit_spot&trades_count=is.null&select=id`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`📊 Remaining null: ${vr.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
