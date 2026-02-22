#!/usr/bin/env node
/**
 * enrich-htx-futures-all.mjs
 * Enrich htx_futures: avatar_url + trades_count (via per-trader stat endpoint)
 * 
 * HTX API:
 * - Ranking: https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank
 *   Returns: userSign (= source_trader_id, base64 of uid), uid, imgUrl, winRate, mdd
 * - Trader stats: https://futures.htx.com/-/x/hbg/v1/futures/copytrading/public/stat?uid=XXX
 *   May return trades_count
 */

const SB_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';
const SB_HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal'
};
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`SB ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbPatch(table, id, data) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: SB_HEADERS, body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Patch ${r.status}: ${await r.text()}`);
}

async function htxFetch(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://futures.htx.com' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

async function main() {
  console.log('=== HTX Futures Enrichment (avatar + trades_count) ===\n');

  // 1. Fetch all DB rows needing enrichment
  let allRows = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet(
      `leaderboard_ranks?source=eq.htx_futures&or=(avatar_url.is.null,trades_count.is.null)&select=id,source_trader_id,avatar_url,trades_count&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    allRows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`DB rows needing enrichment: ${allRows.length}`);
  if (!allRows.length) { console.log('Nothing to do.'); return; }

  // Build lookup: source_trader_id → [rows]
  const lookup = new Map();
  for (const r of allRows) {
    const key = r.source_trader_id.replace(/=+$/, ''); // strip trailing =
    if (!lookup.has(key)) lookup.set(key, []);
    lookup.get(key).push(r);
  }

  // 2. Fetch ALL traders from HTX ranking API (all pages)
  const apiTraders = new Map(); // userSign (trimmed) → { imgUrl, uid }
  let page = 1;
  let totalFetched = 0;

  console.log('Fetching HTX ranking API...');
  while (true) {
    const json = await htxFetch(
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=50`
    );
    const items = json?.data?.itemList || [];
    if (!items.length) break;

    for (const item of items) {
      const sign = (item.userSign || '').replace(/=+$/, '');
      if (sign) {
        apiTraders.set(sign, {
          uid: item.uid,
          imgUrl: item.imgUrl || null,
        });
      }
    }
    totalFetched += items.length;
    if (items.length < 50) break;
    page++;
    await sleep(200);
  }
  console.log(`API fetched ${totalFetched} traders (${apiTraders.size} unique signs, ${page-1} pages)\n`);

  // 3. Try to get trades_count via individual stat endpoint (check a few UIDs)
  // First check if a known endpoint exists
  const sampleTrader = [...apiTraders.values()][0];
  if (sampleTrader?.uid) {
    const statPaths = [
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/public/stat?uid=${sampleTrader.uid}`,
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/stat?uid=${sampleTrader.uid}`,
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/traderstat?uid=${sampleTrader.uid}`,
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/trader/stat?uid=${sampleTrader.uid}`,
    ];
    for (const sp of statPaths) {
      const r = await htxFetch(sp);
      if (r && r.data && !r.error) {
        console.log(`Stat endpoint works: ${sp.split('?')[0]}`);
        console.log('  Data keys:', Object.keys(r.data || {}).slice(0, 10));
        break;
      }
    }
  }

  // 4. Match and update
  let avatarUpdated = 0, tcUpdated = 0, matched = 0;

  for (const [sign, apiData] of apiTraders) {
    const rows = lookup.get(sign);
    if (!rows) continue;
    matched++;

    for (const row of rows) {
      const update = {};
      if (row.avatar_url === null && apiData.imgUrl && apiData.imgUrl.startsWith('http')) {
        update.avatar_url = apiData.imgUrl;
      }
      // trades_count not available from ranking API - skip for now
      if (Object.keys(update).length === 0) continue;

      await sbPatch('leaderboard_ranks', row.id, update);
      if (update.avatar_url) avatarUpdated++;
    }
  }

  // 5. For trades_count, try individual API calls for traders still missing it
  console.log('\n--- Trying individual API for trades_count ---');
  const missingTc = allRows.filter(r => r.trades_count === null);
  console.log(`${missingTc.length} rows missing trades_count`);

  // Build uid lookup from API data
  const signToUid = new Map([...apiTraders.entries()].map(([s, d]) => [s, d.uid]));

  let tcTried = 0, tcGot = 0;
  const triedUids = new Set();
  
  for (const row of missingTc) {
    const sign = row.source_trader_id.replace(/=+$/, '');
    const uid = signToUid.get(sign);
    if (!uid || triedUids.has(uid)) continue;
    triedUids.add(uid);
    tcTried++;

    // Try multiple endpoints for trades count
    let tc = null;
    const endpoints = [
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/public/record?uid=${uid}`,
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/history?uid=${uid}&pageNo=1&pageSize=1`,
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/public/history?uid=${uid}&pageNo=1&pageSize=1`,
      `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/orderCount?uid=${uid}`,
    ];
    
    for (const ep of endpoints) {
      const json = await htxFetch(ep);
      if (json?.data) {
        const d = json.data;
        const candidate = d.totalCount || d.total || d.orderCount || d.count;
        if (candidate != null && Number.isFinite(+candidate)) {
          tc = +candidate;
          break;
        }
      }
    }

    if (tc !== null) {
      // Update all rows for this trader
      const rows = lookup.get(sign) || [];
      for (const r of rows) {
        if (r.trades_count === null) {
          await sbPatch('leaderboard_ranks', r.id, { trades_count: tc });
          tcGot++;
        }
      }
    }

    if (tcTried % 20 === 0) {
      console.log(`  TC: tried=${tcTried}, got=${tcGot}`);
    }
    await sleep(150);
    if (tcTried >= 100) break; // Try first 100 to see if any endpoint works
  }

  console.log(`\n✅ HTX Results:`);
  console.log(`  API traders: ${apiTraders.size}`);
  console.log(`  Matched to DB: ${matched}`);
  console.log(`  Avatar updated: ${avatarUpdated}`);
  console.log(`  TC tried: ${tcTried}, TC updated: ${tcGot}`);

  // Verify
  const verify = async (field) => {
    const r = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.htx_futures&${field}=is.null&select=id`, {
      headers: { ...SB_HEADERS, Prefer: 'count=exact', Range: '0-0' }
    });
    return r.headers.get('content-range');
  };
  console.log('\n📊 Verification:');
  console.log(`  avatar_url null: ${await verify('avatar_url')}`);
  console.log(`  trades_count null: ${await verify('trades_count')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
