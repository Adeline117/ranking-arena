#!/usr/bin/env node
/**
 * enrich-bybit-spot-tc.mjs
 * Fill NULL trades_count for bybit_spot leaderboard_ranks
 * 
 * bybit_spot source_trader_id = leaderUserId (numeric, like "191585431")
 * 
 * Strategy:
 * 1. Paginate dynamic-leader-list to get leaderUserId → leaderMark mapping
 * 2. Use leader-income with leaderMark to get cumTradeCount
 * 3. Update trades_count
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
  console.log('=== Bybit Spot TC Enrichment ===\n');

  // Get rows missing TC
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

  // Group by trader
  const traderMap = new Map();
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, []);
    traderMap.get(r.source_trader_id).push(r);
  }
  console.log(`Unique traders: ${traderMap.size}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  let page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('Getting Bybit session...');
  try {
    await page.goto('https://www.bybit.com/copyTrading/traderRanking', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
  } catch (e) {
    console.log('  Nav note:', e.message.slice(0, 60));
  }
  await sleep(4000);

  // Step 1: Build leaderUserId → leaderMark mapping by paginating the listing
  console.log('\n--- Step 1: Building UID → leaderMark mapping ---');
  const uidToMark = new Map(); // uid string → leaderMark base64
  const targetUids = new Set(traderMap.keys());
  
  const DURATIONS = ['DATA_DURATION_SEVEN_DAY', 'DATA_DURATION_THIRTY_DAY', 'DATA_DURATION_NINETY_DAY'];
  
  for (const dur of DURATIONS) {
    let pg = 1;
    let empty = 0;
    
    while (pg <= 300 && uidToMark.size < targetUids.size) {
      const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pg}&pageSize=50&dataDuration=${dur}&sortField=LEADER_SORT_FIELD_SORT_ROI`;
      
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (!text || text.startsWith('<')) { empty++; break; }
        const json = JSON.parse(text);
        if (json?.retCode !== 0) break;
        
        const items = json?.result?.leaderDetails || [];
        if (!items.length) { empty++; if (empty >= 2) break; pg++; continue; }
        empty = 0;
        
        let added = 0;
        for (const item of items) {
          const uid = String(item.leaderUserId || '');
          const mark = item.leaderMark || '';
          if (uid && mark && targetUids.has(uid) && !uidToMark.has(uid)) {
            uidToMark.set(uid, mark);
            added++;
          }
        }
        
        if (pg % 20 === 0) {
          console.log(`  ${dur} p${pg}: ${uidToMark.size}/${targetUids.size} mapped`);
        }
        pg++;
        await sleep(150);
      } catch { break; }
    }
    
    console.log(`  After ${dur}: ${uidToMark.size}/${targetUids.size} mapped`);
    if (uidToMark.size >= targetUids.size) break;
  }

  console.log(`\nMapped ${uidToMark.size} of ${targetUids.size} traders`);

  // Step 2: Fetch leader-income for each trader with a known mark
  console.log('\n--- Step 2: Fetching leader-income for each trader ---');
  let updated = 0, noData = 0, errors = 0;
  
  const markEntries = [...uidToMark.entries()];
  
  for (let i = 0; i < markEntries.length; i++) {
    const [uid, mark] = markEntries[i];
    const rows = traderMap.get(uid) || [];
    
    if (i > 0 && i % 200 === 0) {
      try {
        await page.goto('https://www.bybit.com/copyTrading/traderRanking', {
          waitUntil: 'domcontentloaded', timeout: 20000
        });
        await sleep(3000);
      } catch {}
    }

    const apiUrl = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(mark)}`;
    
    try {
      const resp = await page.goto(apiUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      if (!resp?.ok()) { errors++; await sleep(500); continue; }
      
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (!text || text.startsWith('<')) { errors++; continue; }
      
      const json = JSON.parse(text);
      if (json.retCode !== 0) { noData++; continue; }
      
      const result = json.result;
      const cumTC = parseInt(result.cumTradeCount || '0');
      if (cumTC === 0) { noData++; continue; }
      
      for (const row of rows) {
        await sbPatch(row.id, { trades_count: cumTC });
        updated++;
      }
    } catch { errors++; }

    if ((i + 1) % 50 === 0) {
      console.log(`  [${i+1}/${markEntries.length}] updated=${updated} noData=${noData} errors=${errors}`);
    }
    await sleep(120);
  }

  await browser.close();

  console.log(`\n✅ Bybit Spot TC Results:`);
  console.log(`  Mapped: ${uidToMark.size}/${targetUids.size}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  No data: ${noData}`);
  console.log(`  Errors: ${errors}`);

  const vr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.bybit_spot&trades_count=is.null&select=id`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`\n📊 Remaining null: ${vr.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
