#!/usr/bin/env node
/**
 * enrich-mexc-avatar.mjs — v2
 * Fill NULL avatar_url for mexc leaderboard_ranks
 * 
 * MEXC API key endpoint: /v1/traders/v2?page={n}&pageSize=20
 * Available after visiting https://www.mexc.com/futures/copyTrade/home
 * Returns: [{ nickname, avatar, uid, ... }]
 * 
 * source_trader_id can be: numeric uid OR nickname string
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

const DEFAULT = ['placeholder', 'default', 'avatar1.8fc6058c', 'banner'];
const isReal = url => url && url.startsWith('http') && !DEFAULT.some(p => url.includes(p));

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
  console.log('=== MEXC Avatar Enrichment v2 ===\n');

  // Get DB rows missing avatar
  let allRows = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet(
      `leaderboard_ranks?source=eq.mexc&avatar_url=is.null&select=id,source_trader_id&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    allRows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`DB rows missing avatar: ${allRows.length}`);
  if (!allRows.length) { console.log('Nothing to do.'); return; }

  // Build lookups (by id and by nickname lower)
  const lookupById = new Map();
  const lookupByNick = new Map();
  for (const r of allRows) {
    const id = r.source_trader_id;
    if (!lookupById.has(id)) lookupById.set(id, []);
    lookupById.get(id).push(r);
    const low = id.toLowerCase();
    if (!lookupByNick.has(low)) lookupByNick.set(low, []);
    lookupByNick.get(low).push(r);
  }

  const avatarMap = new Map(); // source_trader_id → avatar_url

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Intercept all XHR/fetch responses to find trader data
  let apiBaseUrl = null;
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('mexc') && !url.includes('mxc') && !url.includes('mexc-cdn')) return;
    if (!url.includes('trader') && !url.includes('copy') && !url.includes('rank') && !url.includes('v1/traders')) return;
    
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const data = await resp.json().catch(() => null);
      if (!data) return;

      // Store the API base URL for pagination
      if (url.includes('/v1/traders/v2') && !apiBaseUrl) {
        apiBaseUrl = url.split('?')[0];
        console.log(`  Found API: ${apiBaseUrl.split('/').slice(-4).join('/')}`);
      }

      let list = data?.data?.content || data?.data?.list || data?.data || [];
      if (!Array.isArray(list) && data?.data?.resultList) list = data.data.resultList;
      if (!Array.isArray(list)) return;

      for (const item of list) {
        const uid = String(item.uid || item.userId || item.traderId || item.id || '');
        const nick = (item.nickname || item.nickName || item.name || '').toLowerCase();
        const avatar = item.avatar || item.avatarUrl || item.headImg || item.headPortrait || item.photoUrl;
        
        if (!isReal(avatar)) continue;

        if (uid && lookupById.has(uid)) avatarMap.set(uid, avatar);
        if (nick && lookupByNick.has(nick)) {
          // Store by nickname for all matching IDs
          for (const row of lookupByNick.get(nick)) {
            avatarMap.set(row.source_trader_id, avatar);
          }
        }
      }
    } catch { /* ignore */ }
  });

  // Load MEXC copy trading page
  console.log('Loading MEXC copy trading page...');
  try {
    await page.goto('https://www.mexc.com/futures/copyTrade/home', {
      waitUntil: 'networkidle2', timeout: 60000
    });
  } catch { console.log('  Load timeout, continuing...'); }
  await sleep(8000);
  console.log(`After initial load: ${avatarMap.size} avatars`);

  // Close popups
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, [class*="close"]')) {
      if (['关闭','OK','Got it','确定','Close','I understand'].some(t => (el.textContent||'').trim().includes(t))) {
        try { el.click(); } catch {}
      }
    }
  }).catch(() => {});
  await sleep(2000);

  // Click All Traders
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if ((el.textContent||'').trim() === 'All Traders' || (el.textContent||'').trim() === '全部交易员') {
        try { el.click(); } catch {}
        return;
      }
    }
  }).catch(() => {});
  await sleep(5000);
  console.log(`After click All Traders: ${avatarMap.size} avatars`);

  // Paginate using the captured API base URL, or try known paths
  const apiPaths = [
    apiBaseUrl,
    'https://www.mexc.com/api/v1/futures/copy_trade/v1/traders/v2',
    'https://futures.mexc.com/api/v1/futures/copy_trade/v1/traders/v2',
    'https://www.mexc.com/api/v1/copy_trade/v1/traders/v2',
    'https://futures.mexc.com/api/v1/contract/copy_trade/ranking',
  ].filter(Boolean);

  for (const apiBase of apiPaths) {
    console.log(`\nTrying pagination at: ${apiBase.split('/').slice(-3).join('/')}`);
    let foundAny = false;

    for (let pg = 1; pg <= 200; pg++) {
      let url;
      if (apiBase.includes('/v1/traders/v2')) {
        url = `${apiBase}?page=${pg}&pageSize=20&period=30&sortField=roi`;
      } else if (apiBase.includes('/ranking')) {
        url = `${apiBase}?type=1&orderBy=ROI&page=${pg}&pageSize=20`;
      } else {
        url = `${apiBase}?page=${pg}&pageSize=20`;
      }

      const result = await page.evaluate(async (fetchUrl) => {
        try {
          const r = await fetch(fetchUrl);
          if (!r.ok) return { error: r.status };
          return r.json();
        } catch (e) { return { error: e.message }; }
      }, url);

      if (result?.error) {
        if (pg === 1) break; // This path doesn't work
        break;
      }

      let list = result?.data?.content || result?.data?.list || result?.data?.resultList || [];
      if (Array.isArray(result?.data)) list = result.data;
      if (!list.length) break;

      foundAny = true;
      for (const item of list) {
        const uid = String(item.uid || item.userId || item.traderId || '');
        const nick = (item.nickname || item.nickName || item.name || '').toLowerCase();
        const avatar = item.avatar || item.avatarUrl || item.headImg || item.headPortrait;
        
        if (!isReal(avatar)) continue;
        if (uid && lookupById.has(uid)) avatarMap.set(uid, avatar);
        if (nick && lookupByNick.has(nick)) {
          for (const row of lookupByNick.get(nick)) avatarMap.set(row.source_trader_id, avatar);
        }
      }

      if (pg % 20 === 0) {
        const matched = allRows.filter(r => avatarMap.has(r.source_trader_id)).length;
        console.log(`  Page ${pg}: ${avatarMap.size} collected, ${matched} DB matched`);
      }
      await sleep(250);
    }

    if (foundAny) {
      const matched = allRows.filter(r => avatarMap.has(r.source_trader_id)).length;
      console.log(`  Path matched: ${matched}/${allRows.length}`);
    }
  }

  // Also try scrolling on the page to trigger more requests
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(2000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(1000);
  }
  console.log(`\nAfter scrolling: ${avatarMap.size} total`);

  await browser.close();

  // Update DB
  let updated = 0;
  for (const row of allRows) {
    const avatar = avatarMap.get(row.source_trader_id);
    if (!avatar) continue;
    await sbPatch(row.id, { avatar_url: avatar });
    updated++;
  }

  console.log(`\n✅ MEXC Avatar Results: ${updated} updated`);
  const vr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.mexc&avatar_url=is.null&select=id`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`📊 Remaining null: ${vr.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
