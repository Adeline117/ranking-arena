#!/usr/bin/env node
/**
 * enrich-mexc-avatar.mjs — v4
 * Fill NULL avatar_url for mexc leaderboard_ranks
 * 
 * MEXC API: intercepted from page (relative URL)
 * The response has: { data: { content: [{ uid, nickname, avatar, ... }] } }
 * - avatar field: real URL like https://public.mocortech.com/banner/...
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal'
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// MEXC avatar CDN domain is public.mocortech.com - not a placeholder
const isReal = url => url && url.startsWith('http') && 
  !['placeholder', 'default_avatar', 'avatar1.8fc6058c', 'noAvatar'].some(p => url.includes(p));

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
  console.log('=== MEXC Avatar Enrichment v4 ===\n');

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
  console.log(`Unique IDs: ${lookupById.size}`);

  const avatarMap = new Map();
  let apiBaseUrl = null;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Intercept to find real API URL and collect avatars
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('mexc') && !url.includes('mocortech')) return;
    if (!url.includes('trader') && !url.includes('copy') && !url.includes('rank')) return;
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const data = await resp.json().catch(() => null);
      if (!data?.data) return;
      
      const list = data.data.content || data.data.list || data.data.resultList || [];
      if (list.length > 0 && !apiBaseUrl && url.includes('traders/v2')) {
        apiBaseUrl = url.split('?')[0];
        console.log(`  Captured API: ${apiBaseUrl.split('/').slice(-5).join('/')}`);
      }
      
      for (const item of list) {
        const uid = String(item.uid || item.userId || '');
        const nick = (item.nickname || item.nickName || '').toLowerCase();
        const avatar = item.avatar || item.avatarUrl || item.headImg || item.photoUrl;
        if (!isReal(avatar)) continue;
        if (uid && lookupById.has(uid)) avatarMap.set(uid, avatar);
        if (nick && lookupByNick.has(nick)) {
          for (const row of lookupByNick.get(nick)) avatarMap.set(row.source_trader_id, avatar);
        }
      }
    } catch { /* */ }
  });

  console.log('Loading MEXC...');
  try {
    await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'networkidle2', timeout: 60000 });
  } catch { console.log('  Load timeout'); }
  await sleep(6000);
  console.log(`After initial load: ${avatarMap.size} avatars`);

  // Close popups
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button,[class*="close"]')) {
      if (['关闭','OK','Got it','确定','Close'].some(t => (el.textContent||'').trim().includes(t))) try { el.click(); } catch {}
    }
  }).catch(() => {});
  await sleep(2000);

  // Click All Traders
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent||'').trim();
      if (t === 'All Traders' || t === '全部交易员') { try { el.click(); } catch {} return; }
    }
  }).catch(() => {});
  await sleep(4000);
  console.log(`After All Traders click: ${avatarMap.size} avatars, API: ${apiBaseUrl || 'not found'}`);

  if (apiBaseUrl) {
    // Paginate using page.goto (same domain, no CORS)
    const periods = [30, 7, 90];
    const sorts = ['roi', 'pnl', 'winRate'];
    
    for (const period of periods) {
      for (const sort of sorts) {
        let pg = 1;
        let noNew = 0;
        
        while (pg <= 300) {
          const url = `${apiBaseUrl}?page=${pg}&pageSize=20&period=${period}&sortField=${sort}`;
          let json = null;
          
          try {
            const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
            if (!resp?.ok()) { noNew++; break; }
            const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
            if (!text || text.startsWith('<')) { noNew++; break; }
            json = JSON.parse(text);
          } catch { noNew++; break; }

          const list = json?.data?.content || json?.data?.list || [];
          if (!list.length) break;
          
          let added = 0;
          for (const item of list) {
            const uid = String(item.uid || '');
            const nick = (item.nickname || '').toLowerCase();
            const avatar = item.avatar || item.avatarUrl || item.headImg;
            if (!isReal(avatar)) continue;
            if (uid && lookupById.has(uid) && !avatarMap.has(uid)) { avatarMap.set(uid, avatar); added++; }
            if (nick && lookupByNick.has(nick)) {
              for (const row of lookupByNick.get(nick)) {
                if (!avatarMap.has(row.source_trader_id)) { avatarMap.set(row.source_trader_id, avatar); added++; }
              }
            }
          }
          
          if (added === 0) noNew++;
          else noNew = 0;
          
          if (pg % 20 === 0) {
            const matched = allRows.filter(r => avatarMap.has(r.source_trader_id)).length;
            console.log(`  p=${period} sort=${sort} pg=${pg}: ${avatarMap.size} total, ${matched} matched`);
          }
          pg++;
          await sleep(150);
          if (noNew >= 5) break;
          if (avatarMap.size >= allRows.length) break;
        }
      }
      const matched = allRows.filter(r => avatarMap.has(r.source_trader_id)).length;
      console.log(`Period ${period}: ${avatarMap.size} avatars, ${matched} DB matched`);
      if (matched >= allRows.length) break;
    }
  } else {
    console.log('⚠ API URL not captured. Trying page.evaluate pagination...');
    // Fall back to in-page fetch
    for (let pg = 1; pg <= 200; pg++) {
      const result = await page.evaluate(async (pg) => {
        try {
          const r = await fetch(`/api/v1/futures/copy_trade/v1/traders/v2?page=${pg}&pageSize=20&period=30&sortField=roi`, {credentials:'include'});
          return r.json();
        } catch (e) { return {error: e.message}; }
      }, pg);
      
      const list = result?.data?.content || [];
      if (!list.length || result?.error) break;
      
      for (const item of list) {
        const uid = String(item.uid || '');
        const nick = (item.nickname || '').toLowerCase();
        const avatar = item.avatar || item.avatarUrl;
        if (!isReal(avatar)) continue;
        if (uid && lookupById.has(uid)) avatarMap.set(uid, avatar);
        if (nick && lookupByNick.has(nick)) for (const row of lookupByNick.get(nick)) avatarMap.set(row.source_trader_id, avatar);
      }
      if (pg % 20 === 0) console.log(`  pg=${pg}: ${avatarMap.size} avatars`);
      await sleep(200);
    }
  }

  await browser.close();
  console.log(`\nTotal collected: ${avatarMap.size}`);

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
