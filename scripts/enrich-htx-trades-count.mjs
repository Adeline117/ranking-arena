#!/usr/bin/env node
/**
 * enrich-htx-trades-count.mjs
 * Fill NULL trades_count for htx_futures leaderboard_ranks
 * 
 * Strategy:
 * - The HTX ranking API at /-/x/hbg/v1/futures/copytrading/rank returns
 *   trader stats but NOT trades_count directly.
 * - Use puppeteer to navigate to the HTX futures copy trading page and 
 *   intercept API responses that contain order count data.
 * - Alternative: Look at the "order/master" API which may show order history.
 * 
 * NOTE: If no API provides trades_count, this script will report 0 updates
 * per the rule: NO fabricated data.
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const SB_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';
const SB_HDR = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal'
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HDR });
  if (!r.ok) throw new Error(`SB ${r.status}`);
  return r.json();
}

async function sbPatch(id, data) {
  const r = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?id=eq.${id}`, {
    method: 'PATCH', headers: SB_HDR, body: JSON.stringify(data)
  });
  if (!r.ok) console.error('Patch error', r.status);
}

async function main() {
  console.log('=== HTX Futures Trades Count Enrichment ===\n');

  // 1. Get DB rows missing trades_count
  let allRows = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet(
      `leaderboard_ranks?source=eq.htx_futures&trades_count=is.null&select=id,source_trader_id,season_id&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    allRows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`Rows missing trades_count: ${allRows.length}`);

  // Build UID lookup (base64 decode source_trader_id = uid string)
  const uidToRows = new Map();
  for (const row of allRows) {
    let uid;
    try {
      uid = Buffer.from(row.source_trader_id, 'base64').toString('utf8');
    } catch { continue; }
    if (!uidToRows.has(uid)) uidToRows.set(uid, []);
    uidToRows.get(uid).push(row);
  }
  console.log(`Unique UIDs: ${uidToRows.size}`);

  // 2. Intercept HTX page to find trades count data
  const tcMap = new Map(); // uid (string) → trades_count

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Intercept responses
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('htx.com') && !url.includes('huobi')) return;
    if (!url.includes('copy') && !url.includes('trader') && !url.includes('order') && !url.includes('stat')) return;
    
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const data = await resp.json();
      if (!data?.data) return;
      
      console.log(`  API: ${url.split('?')[0].split('/').slice(-3).join('/')} - keys: ${Object.keys(data.data).join(',').slice(0,80)}`);
      
      // Look for trades_count/order_count related fields
      const d = data.data;
      const candidates = [
        d.orderNum, d.orderCount, d.totalCount, d.tradeCount, d.tradesCount,
        d.dealNum, d.dealCount, d.followOrderNum, d.historyOrderNum,
        d.closeOrderNum, d.openOrderNum
      ].filter(v => v != null && Number.isFinite(+v));
      
      if (candidates.length > 0) {
        console.log(`    Found candidates: ${JSON.stringify(candidates)}`);
        // Also look for uid in response
        const uid = String(d.uid || d.userId || '');
        if (uid) {
          tcMap.set(uid, candidates[0]);
        }
      }
      
      // itemList from ranking API
      if (Array.isArray(d.itemList)) {
        for (const item of d.itemList) {
          const uid = String(item.uid || '');
          const candidates2 = [item.orderNum, item.orderCount, item.totalOrders, item.tradeCount]
            .filter(v => v != null && Number.isFinite(+v));
          if (uid && candidates2.length > 0) {
            tcMap.set(uid, candidates2[0]);
          }
        }
      }
    } catch { /* ignore */ }
  });

  // Load HTX futures copy trading page
  console.log('Loading HTX futures copy trading page...');
  try {
    await page.goto('https://futures.htx.com/en-us/copy-trading/trader-ranking', {
      waitUntil: 'networkidle2', timeout: 30000
    });
  } catch (e) {
    console.log('  Nav note:', e.message.substring(0, 60));
  }
  await sleep(6000);
  
  // Try to click on a specific trader to see detail API
  const uids = [...uidToRows.keys()].slice(0, 5);
  for (const uid of uids) {
    console.log(`\nTrying to load detail for uid ${uid}...`);
    try {
      await page.goto(`https://futures.htx.com/en-us/copy-trading/master-center?uid=${uid}`, {
        waitUntil: 'networkidle2', timeout: 20000
      });
      await sleep(3000);
    } catch (e) {
      console.log('  Nav err:', e.message.substring(0, 50));
    }
  }

  await browser.close();
  
  console.log(`\ntradeCount data captured: ${tcMap.size} UIDs`);

  if (tcMap.size === 0) {
    console.log('\n⚠ No trades_count data found via HTX page.');
    console.log('HTX does not expose per-trader trades_count in any public API.');
    console.log('This field cannot be filled without auth credentials or private API access.');
    return;
  }

  // 3. Update DB
  let updated = 0;
  for (const [uid, tc] of tcMap) {
    const rows = uidToRows.get(uid) || [];
    for (const row of rows) {
      if (row.trades_count !== null) continue;
      await sbPatch(row.id, { trades_count: tc });
      updated++;
    }
  }

  console.log(`✅ Updated: ${updated}`);
  const vr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.htx_futures&trades_count=is.null&select=id`, {
    headers: { ...SB_HDR, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`📊 Remaining null: ${vr.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
