#!/usr/bin/env node
/**
 * enrich-mexc-avatar-v3.mjs
 * Fill NULL avatar_url for mexc leaderboard_ranks
 *
 * Strategy:
 *   MEXC uses Akamai protection. Use Puppeteer to load the MEXC futures
 *   copy-trading home page, intercept the v1/traders/v2 API responses,
 *   then call additional pages via page.evaluate (which shares cookies).
 *   The page naturally calls page=1 COMPREHENSIVE; we call remaining pages
 *   from within the browser context.
 *
 * Run:
 *   node scripts/enrich-mexc-avatar-v3.mjs 2>&1 | tee /tmp/mexc-avatar-v3.log
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

// MEXC avatars are at public.mocortech.com/banner/ or similar paths — do NOT filter /banner/
// Only filter known MEXC default/generic avatar patterns
const DEFAULT_AVATAR_PATTERNS = ['avatar1.8fc6058c', 'placeholder', 'default_avatar', 'default.png', 'default.jpg', '/default/'];
const isRealAvatar = url => url && url.startsWith('http') && !DEFAULT_AVATAR_PATTERNS.some(p => url.includes(p));

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbPatch(id, data) {
  const r = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?id=eq.${id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify(data)
  });
  if (!r.ok) console.error(`  PATCH error ${r.status}`);
}

function extractTraders(data) {
  if (!data) return [];
  const list = data?.data?.content || data?.data?.list || data?.data?.items || data?.list || [];
  if (Array.isArray(list)) return list;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function main() {
  console.log('=== MEXC Avatar Enrichment v3 (Interception) ===\n');

  // ── Step 1: Load null-avatar LR rows ─────────────────────────────────────
  let lrRows = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet(
      `leaderboard_ranks?source=eq.mexc&avatar_url=is.null&select=id,source_trader_id&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    lrRows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`LR rows missing avatar: ${lrRows.length}`);
  if (!lrRows.length) { console.log('Nothing to do.'); return; }

  // Build lookup: nicknameLower → [rows]
  const lookupByNick = new Map();
  for (const r of lrRows) {
    const nick = (r.source_trader_id || '').toLowerCase().trim();
    if (!lookupByNick.has(nick)) lookupByNick.set(nick, []);
    lookupByNick.get(nick).push(r);
  }
  console.log(`Unique nicknames to find: ${lookupByNick.size}\n`);

  // ── Step 2: Launch browser and collect avatars ────────────────────────────
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Intercept responses from the MEXC traders API
  const avatarMap = new Map(); // nickLower → avatar_url
  let interceptedPages = new Set();

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('copyFutures/api/v1/traders') && !url.includes('copy/v1/recommend/traders')) return;
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const data = await response.json();
      const traders = extractTraders(data);
      for (const item of traders) {
        const nick = (item.nickname || item.nickName || item.name || item.displayName || '').toLowerCase().trim();
        const avatar = item.avatar || item.avatarUrl || item.headImg || item.profileImg || null;
        if (nick && avatar && isRealAvatar(avatar) && lookupByNick.has(nick)) {
          avatarMap.set(nick, avatar);
        }
      }
      // Track which page was intercepted
      const pgMatch = url.match(/[?&]page=(\d+)/);
      if (pgMatch) interceptedPages.add(parseInt(pgMatch[1]));
    } catch { /* ignore */ }
  });

  // Load MEXC
  console.log('Loading MEXC...');
  try {
    await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log('  Load note:', e.message.substring(0, 60));
  }
  await sleep(8000); // Wait for initial API call to complete

  console.log(`After page load: ${avatarMap.size} matched, intercepted pages: ${[...interceptedPages].join(',')}`);

  // Now paginate using page.evaluate (shares cookies with the page)
  const ORDERS = ['COMPREHENSIVE', 'ROI', 'FOLLOWERS', 'PNL', 'WIN_RATE'];
  const PAGE_LIMIT = 150; // 150 pages × 30 per page = 4500 traders

  for (const orderBy of ORDERS) {
    console.log(`  Scanning ${orderBy}...`);
    let emptyStreak = 0;

    for (let pg = 1; pg <= PAGE_LIMIT; pg++) {
      // Skip page 1 COMPREHENSIVE if already intercepted
      if (orderBy === 'COMPREHENSIVE' && pg === 1 && interceptedPages.has(1)) {
        continue;
      }

      const result = await page.evaluate(async (p, ob) => {
        try {
          const url = `/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=30&orderBy=${ob}&page=${p}`;
          const r = await fetch(url);
          if (!r.ok) return { error: r.status, items: [] };
          const d = await r.json();
          const items = d?.data?.content || [];
          return { items, total: d?.data?.totalElements };
        } catch (e) {
          return { error: e.message, items: [] };
        }
      }, pg, orderBy);

      if (!result.items || result.items.length === 0) {
        emptyStreak++;
        if (emptyStreak >= 3) break;
        await sleep(500);
        continue;
      }
      emptyStreak = 0;

      let newFound = 0;
      for (const item of result.items) {
        const nick = (item.nickname || item.nickName || item.name || item.displayName || '').toLowerCase().trim();
        const avatar = item.avatar || item.avatarUrl || item.headImg || item.profileImg || null;
        if (nick && avatar && isRealAvatar(avatar) && lookupByNick.has(nick)) {
          if (!avatarMap.has(nick)) { avatarMap.set(nick, avatar); newFound++; }
        }
      }

      if (newFound > 0 || pg % 20 === 0) {
        const pct = Math.round(avatarMap.size / lookupByNick.size * 100);
        process.stdout.write(`    ${orderBy} p${pg}: total=${avatarMap.size}/${lookupByNick.size} (${pct}%) new=${newFound}\n`);
      }

      if (avatarMap.size >= lookupByNick.size) break;
      await sleep(200);
    }

    console.log(`  ${orderBy} done. Found: ${avatarMap.size}/${lookupByNick.size}`);
    if (avatarMap.size >= lookupByNick.size) {
      console.log('  All traders found!');
      break;
    }
    await sleep(500);
  }

  await browser.close();
  console.log(`\nTotal avatars collected: ${avatarMap.size} / ${lookupByNick.size}`);

  // ── Step 3: Update DB ────────────────────────────────────────────────────
  let updated = 0, noMatch = 0;

  for (const row of lrRows) {
    const nick = (row.source_trader_id || '').toLowerCase().trim();
    const avatar = avatarMap.get(nick);
    if (!avatar) { noMatch++; continue; }

    await sbPatch(row.id, { avatar_url: avatar });
    updated++;
    if (updated % 100 === 0) console.log(`  Updated ${updated}...`);
    await sleep(20);
  }

  console.log(`\n✅ MEXC Avatar Results:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  No match (traders not in current MEXC leaderboard): ${noMatch}`);

  // Verify
  const vr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.mexc&avatar_url=is.null&select=id`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`\n📊 Remaining MEXC avatar nulls: ${vr.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
