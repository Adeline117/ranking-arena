#!/usr/bin/env node
/**
 * enrich-mexc-avatar-v2.mjs
 * Fill NULL avatar_url for mexc leaderboard_ranks
 *
 * Strategy:
 *   MEXC is Cloudflare-protected. Use Puppeteer to load the MEXC page,
 *   then use page.evaluate() to call the MEXC API from inside the browser
 *   (bypassing Cloudflare). Paginate through all traders and build a
 *   nickname → avatar_url map.
 *
 * Run:
 *   node scripts/enrich-mexc-avatar-v2.mjs 2>&1 | tee /tmp/mexc-avatar.log
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

const DEFAULT_AVATAR_PATTERNS = ['avatar1.8fc6058c', '/banner/', 'placeholder', 'default_avatar', 'default.png', 'default.jpg'];
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

async function main() {
  console.log('=== MEXC Avatar Enrichment v2 ===\n');

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

  // ── Step 2: Launch Puppeteer and gather avatars ──────────────────────────
  console.log('Launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Load MEXC to get auth cookies / bypass Cloudflare
  console.log('Loading MEXC copy trading page...');
  try {
    await page.goto('https://www.mexc.com/futures/copyTrade/home', {
      waitUntil: 'domcontentloaded', timeout: 45000
    });
  } catch (e) {
    console.log('  Load note:', e.message.substring(0, 60));
  }
  await sleep(6000);
  console.log('  Page loaded, starting API scan...\n');

  // avatarMap: nicknameLower → avatar_url
  const avatarMap = new Map();

  // Scan multiple sort orders to maximize coverage
  const sortOrders = ['COMPREHENSIVE', 'ROI', 'FOLLOWERS', 'PNL', 'WIN_RATE'];

  for (const orderBy of sortOrders) {
    console.log(`  Scanning order: ${orderBy}...`);
    let consecutive_empty = 0;

    for (let pageNum = 1; pageNum <= 150; pageNum++) {
      try {
        const items = await page.evaluate(async (pg, ob) => {
          try {
            const url = `/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=30&orderBy=${ob}&page=${pg}`;
            const r = await fetch(url, { credentials: 'include' });
            const d = await r.json();
            return d?.data?.content || d?.data?.list || d?.data?.items || null;
          } catch { return null; }
        }, pageNum, orderBy);

        if (!items || !Array.isArray(items) || items.length === 0) {
          consecutive_empty++;
          if (consecutive_empty >= 3) break;
          await sleep(500);
          continue;
        }
        consecutive_empty = 0;

        let newFound = 0;
        for (const item of items) {
          const nick = (item.nickname || item.nickName || item.name || item.displayName || '').toLowerCase().trim();
          const avatar = item.avatar || item.avatarUrl || item.headImg || item.profileImg || item.headPortrait || null;

          if (!nick || !avatar || !isRealAvatar(avatar)) continue;
          if (!avatarMap.has(nick) && lookupByNick.has(nick)) {
            avatarMap.set(nick, avatar);
            newFound++;
          }
        }

        const pct = Math.round(avatarMap.size / lookupByNick.size * 100);
        if (pageNum % 20 === 0 || newFound > 0) {
          process.stdout.write(`    Page ${pageNum}: collected ${avatarMap.size}/${lookupByNick.size} (${pct}%)\r`);
        }

        // Stop if we've found all traders we need
        if (avatarMap.size >= lookupByNick.size) break;

        await sleep(300);
      } catch (e) {
        console.log(`  Error page ${pageNum}:`, e.message.substring(0, 60));
        await sleep(1000);
      }
    }

    console.log(`\n  ${orderBy} done. Avatars found so far: ${avatarMap.size}/${lookupByNick.size}`);
    if (avatarMap.size >= lookupByNick.size) {
      console.log('  All traders found, stopping early.');
      break;
    }
    await sleep(1000);
  }

  await browser.close();
  console.log(`\nTotal avatars collected: ${avatarMap.size} / ${lookupByNick.size}`);

  // ── Step 3: Match and update DB ───────────────────────────────────────────
  let updated = 0, noMatch = 0;

  for (const row of lrRows) {
    const nick = (row.source_trader_id || '').toLowerCase().trim();
    const avatar = avatarMap.get(nick);
    if (!avatar) { noMatch++; continue; }

    await sbPatch(row.id, { avatar_url: avatar });
    updated++;
    await sleep(20);

    if (updated % 100 === 0) console.log(`  Updated ${updated} rows...`);
  }

  console.log(`\n✅ MEXC Avatar Results:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  No match: ${noMatch}`);

  // ── Verify ───────────────────────────────────────────────────────────────
  const vr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.mexc&avatar_url=is.null&select=id`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`\n📊 Remaining MEXC avatar nulls: ${vr.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
