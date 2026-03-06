#!/usr/bin/env node
/**
 * enrich-bybit-avatar.mjs
 * Fill NULL avatar_url for bybit leaderboard_ranks
 * 
 * Strategy:
 * 1. Launch puppeteer on bybit.com/copyTrading to get cookies/session
 * 2. Paginate /x-api/fapi/beehive/public/v1/common/dynamic-leader-list (all periods)
 * 3. Match by leaderMark (= source_trader_id) and get profilePhoto
 * 4. Update leaderboard_ranks
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_HDR = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal'
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DEFAULT_AVATAR_PATTERNS = ['deadpool', 'placeholder', 'default_avatar', 'default.png'];
const isRealAvatar = url => url && url.startsWith('http') && !DEFAULT_AVATAR_PATTERNS.some(p => url.includes(p));

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HDR });
  if (!r.ok) throw new Error(`SB ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbPatch(table, id, data) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: SB_HDR, body: JSON.stringify(data)
  });
  if (!r.ok) console.error(`Patch error ${r.status}`);
}

async function main() {
  console.log('=== Bybit Avatar Enrichment ===\n');

  // 1. Get DB rows missing avatar
  let allRows = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet(
      `leaderboard_ranks?source=eq.bybit&avatar_url=is.null&select=id,source_trader_id&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    allRows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`DB rows missing avatar: ${allRows.length}`);
  if (!allRows.length) { console.log('Nothing to do.'); return; }

  // Build lookup: leaderMark → [row ids]
  const lookup = new Map();
  for (const r of allRows) {
    if (!lookup.has(r.source_trader_id)) lookup.set(r.source_trader_id, []);
    lookup.get(r.source_trader_id).push(r.id);
  }
  console.log(`Unique leaderMarks: ${lookup.size}`);

  // 2. Launch puppeteer
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  console.log('Visiting bybit.com to get session...');
  try {
    await page.goto('https://www.bybit.com/copyTrading/traderRanking', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
  } catch (e) {
    console.log('  Navigation note:', e.message.substring(0, 60));
  }
  await sleep(4000);

  // 3. Fetch all pages of all periods
  const avatarMap = new Map(); // leaderMark → profilePhoto
  const DURATIONS = [
    'DATA_DURATION_SEVEN_DAY',
    'DATA_DURATION_THIRTY_DAY',
    'DATA_DURATION_NINETY_DAY',
  ];
  const PAGE_SIZE = 50;

  for (const duration of DURATIONS) {
    console.log(`\nFetching ${duration}...`);
    let apiPage = 1;
    let consecutive_empty = 0;

    while (true) {
      const url = `/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${apiPage}&pageSize=${PAGE_SIZE}&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`;

      const result = await page.evaluate(async (apiUrl) => {
        try {
          const r = await fetch(apiUrl, { credentials: 'include' });
          if (!r.ok) return { error: r.status };
          return r.json();
        } catch (e) { return { error: e.message }; }
      }, url);

      if (result?.error) {
        console.log(`  Page ${apiPage}: error ${result.error}`);
        break;
      }
      if (result?.retCode !== 0) {
        console.log(`  Page ${apiPage}: retCode=${result?.retCode} ${result?.retMsg}`);
        break;
      }

      const items = result?.result?.leaderDetails || [];
      if (!items.length) {
        consecutive_empty++;
        if (consecutive_empty >= 2) break;
      } else {
        consecutive_empty = 0;
        let newFound = 0;
        for (const item of items) {
          const mark = item.leaderMark;
          const photo = item.profilePhoto;
          if (mark && photo && isRealAvatar(photo) && !avatarMap.has(mark)) {
            avatarMap.set(mark, photo);
            newFound++;
          }
        }
        if (apiPage % 10 === 0) {
          console.log(`  Page ${apiPage}: ${items.length} items, ${newFound} new. Total: ${avatarMap.size}`);
        }
      }

      apiPage++;
      await sleep(150);
      if (apiPage > 200) break; // Safety limit
    }
    console.log(`  Completed ${duration}: total ${avatarMap.size} avatars collected`);
  }

  await browser.close();
  console.log(`\nTotal unique avatars collected: ${avatarMap.size}`);

  // 4. Match & update
  let updated = 0, matched = 0;
  for (const [mark, photo] of avatarMap) {
    const ids = lookup.get(mark);
    if (!ids) continue;
    matched++;
    for (const id of ids) {
      await sbPatch('leaderboard_ranks', id, { avatar_url: photo });
      updated++;
    }
  }

  console.log(`\n✅ Bybit Avatar Results:`);
  console.log(`  Collected: ${avatarMap.size} avatars from API`);
  console.log(`  Matched to DB: ${matched} unique traders`);
  console.log(`  Updated rows: ${updated}`);

  // Verify
  const vr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.bybit&avatar_url=is.null&select=id`, {
    headers: { ...SB_HDR, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`\n📊 Remaining avatar nulls: ${vr.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
