#!/usr/bin/env node
/**
 * enrich-bitget-avatar.mjs
 * Fill NULL avatar_url for bitget_futures and bitget_spot leaderboard_ranks
 * 
 * Strategy:
 * 1. Cross-fill from trader_sources (fast)
 * 2. Use Playwright to access internal Bitget API:
 *    POST /v1/trigger/trace/public/traderViewV3 (returns headPic per traderUid)
 * 3. Fall back to individual trader profile pages
 * 
 * source_trader_id = traderUid (hex string like "bdb24d778fb23b56ad91")
 */
import { chromium } from 'playwright';

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal'
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FAKE = ['placeholder', 'dicebear', 'identicon', 'boringavatar', 'default-avatar'];
const isReal = url => url && typeof url === 'string' && url.startsWith('http') && !FAKE.some(p => url.includes(p));

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

function extractFromApiData(data, avatarMap) {
  if (!data) return;
  const rows = data.rows || data.list || data.traderList || data.data?.rows || data.data?.list || [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const uid = String(row.traderUid || row.traderId || row.uid || '');
    const pic = row.headPic || row.headUrl || row.avatar || row.portraitLink || row.profileImg;
    if (uid && isReal(pic)) avatarMap.set(uid, pic);
  }
  if (Array.isArray(data)) {
    for (const row of data) {
      const uid = String(row.traderUid || row.traderId || row.uid || '');
      const pic = row.headPic || row.headUrl || row.avatar;
      if (uid && isReal(pic)) avatarMap.set(uid, pic);
    }
  }
}

async function enrichSource(source, browser) {
  console.log(`\n=== ${source} ===`);

  // Get rows missing avatar
  let lrRows = [];
  let off = 0;
  while (true) {
    const b = await sbGet(`leaderboard_ranks?source=eq.${source}&avatar_url=is.null&select=id,source_trader_id&limit=1000&offset=${off}`);
    if (!b?.length) break;
    lrRows.push(...b);
    if (b.length < 1000) break;
    off += 1000;
  }
  console.log(`  Missing avatar: ${lrRows.length}`);
  if (!lrRows.length) return 0;

  const missingIds = new Set(lrRows.map(r => r.source_trader_id));

  // 1. Cross-fill from trader_sources
  const tsRows = await sbGet(`trader_sources?source=eq.${source}&avatar_url=not.is.null&select=source_trader_id,avatar_url&limit=5000`);
  const tsMap = new Map(tsRows.filter(r => isReal(r.avatar_url)).map(r => [r.source_trader_id, r.avatar_url]));

  let crossFilled = 0;
  for (const row of lrRows) {
    const av = tsMap.get(row.source_trader_id);
    if (av) {
      await sbPatch(row.id, { avatar_url: av });
      crossFilled++;
      missingIds.delete(row.source_trader_id);
    }
  }
  console.log(`  Cross-filled: ${crossFilled}`);
  if (missingIds.size === 0) return crossFilled;

  const avatarMap = new Map();
  
  // 2. Launch Playwright and fetch from Bitget API
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  // Intercept responses
  page.on('response', async r => {
    const url = r.url();
    if (!url.includes('bitget.com')) return;
    if (!url.includes('trader') && !url.includes('traderView') && !url.includes('copy')) return;
    try {
      const ct = r.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const data = await r.json().catch(() => null);
      if (!data) return;
      extractFromApiData(data, avatarMap);
      extractFromApiData(data?.data, avatarMap);
    } catch { /* */ }
  });

  const isSpot = source === 'bitget_spot';
  const baseUrl = isSpot
    ? 'https://www.bitget.com/copy-trading/spot/traders'
    : 'https://www.bitget.com/copy-trading/futures/traders';

  console.log(`  Loading ${baseUrl}...`);
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (e) {
    console.log(`  Nav note: ${e.message.slice(0, 60)}`);
  }
  await sleep(5000);

  // Try to paginate via internal API
  const periodTypes = isSpot ? ['30D'] : ['30D', '7D', '90D'];
  const sortKeys = ['profitRatio', 'profit', 'roi'];
  
  for (const periodType of periodTypes) {
    for (const sortKey of sortKeys) {
      let pageNo = 1;
      while (true) {
        const apiUrl = isSpot
          ? `https://api.bitget.com/api/v2/copy/spot-trader/queryall-follower-leaderboard?periodType=${periodType}&sortKey=${sortKey}&pageNo=${pageNo}&pageSize=50`
          : `https://api.bitget.com/api/v2/copy/mix-trader/queryall-follower-leaderboard?productType=USDT-FUTURES&periodType=${periodType}&sortKey=${sortKey}&pageNo=${pageNo}&pageSize=50`;

        const result = await page.evaluate(async (url) => {
          try {
            const r = await fetch(url);
            return r.json();
          } catch (e) { return { error: e.message }; }
        }, apiUrl);

        if (result?.error) break;
        
        const rows = result?.data?.resultList || result?.data?.rows || result?.data?.list || [];
        if (!rows.length) break;

        for (const t of rows) {
          const uid = String(t.traderUid || t.traderId || t.uid || '');
          const pic = t.headPic || t.headUrl || t.avatar || t.traderHeadUrl;
          if (uid && isReal(pic)) avatarMap.set(uid, pic);
        }

        const found = lrRows.filter(r => avatarMap.has(r.source_trader_id) && missingIds.has(r.source_trader_id)).length;
        if (rows.length < 50 || !result?.data?.nextFlag) break;
        pageNo++;
        await sleep(300);
      }
    }
    if (avatarMap.size > 0) {
      const matched = lrRows.filter(r => avatarMap.has(r.source_trader_id) && missingIds.has(r.source_trader_id)).length;
      console.log(`  ${periodType}: ${avatarMap.size} collected, ${matched} matched`);
      if (matched >= missingIds.size) break;
    }
  }

  // Also try individual trader pages for remaining missing ones
  const stillMissing = lrRows.filter(r => missingIds.has(r.source_trader_id) && !avatarMap.has(r.source_trader_id)).slice(0, 100);
  console.log(`  Trying ${stillMissing.length} individual pages...`);
  
  for (let i = 0; i < stillMissing.length; i++) {
    const trader = stillMissing[i];
    const detailUrl = isSpot
      ? `https://www.bitget.com/copy-trading/spot/trader/${trader.source_trader_id}`
      : `https://www.bitget.com/copy-trading/futures/trade-center/detail?traderId=${trader.source_trader_id}`;

    let found = null;
    const handler = async (resp) => {
      if (resp.status() !== 200) return;
      const url = resp.url();
      if (!url.includes('traderView') && !url.includes('traderDetail') && !url.includes('currentTrader') && !url.includes('cycleData')) return;
      try {
        const d = await resp.json().catch(() => null);
        if (!d) return;
        const pic = d?.data?.headPic || d?.data?.headUrl || d?.data?.avatar || d?.data?.traderInfo?.headPic;
        if (isReal(pic)) found = pic;
      } catch { /* */ }
    };
    page.on('response', handler);

    try {
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2500);
    } catch { /* */ }

    page.off('response', handler);
    if (found) avatarMap.set(trader.source_trader_id, found);

    if ((i + 1) % 20 === 0) {
      console.log(`  Individual: ${i+1}/${stillMissing.length} (${avatarMap.size} total)`);
    }
    await sleep(800);
  }

  await ctx.close();

  // 3. Update DB
  let apiUpdated = 0;
  for (const row of lrRows) {
    if (!missingIds.has(row.source_trader_id)) continue;
    const av = avatarMap.get(row.source_trader_id);
    if (!av) continue;
    await sbPatch(row.id, { avatar_url: av });
    apiUpdated++;
  }

  console.log(`  API updated: ${apiUpdated}`);
  return crossFilled + apiUpdated;
}

async function main() {
  console.log('=== Bitget Avatar Enrichment (futures + spot) ===');
  
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  try {
    const futuresTotal = await enrichSource('bitget_futures', browser);
    const spotTotal = await enrichSource('bitget_spot', browser);
    
    console.log(`\n✅ Total updated: bitget_futures=${futuresTotal}, bitget_spot=${spotTotal}`);
  } finally {
    await browser.close();
  }

  // Verify
  const sources = ['bitget_futures', 'bitget_spot'];
  for (const s of sources) {
    const r = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.${s}&avatar_url=is.null&select=id`, {
      headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
    });
    console.log(`📊 ${s} remaining null: ${r.headers.get('content-range')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
