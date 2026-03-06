#!/usr/bin/env node
/**
 * enrich-okx-tc-v3.mjs
 * Fill NULL trades_count for okx_futures leaderboard_ranks
 *
 * Strategy:
 *   1. Scan all pages of OKX public copy-trading leaderboard to build a
 *      uniqueCode → trader map.
 *   2. For each LR row with null trades_count whose trader is on the current
 *      leaderboard, fetch public-subpositions-history and count trades.
 *   3. For traders NOT on current leaderboard the data is not exposed via
 *      OKX public API — noted as structural limitation.
 *
 * Run:
 *   node scripts/enrich-okx-tc-v3.mjs 2>&1 | tee /tmp/okx-tc.log
 */

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal'
};
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.okx.com/api/v5/copytrading';
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!res.ok) return null;
      return res.json();
    } catch (e) { if (i < 2) await sleep(1000); }
  }
  return null;
}

async function getTradesCount(uniqueCode) {
  let total = 0;
  let after = '';
  for (let page = 0; page < 30; page++) {
    const url = `${BASE}/public-subpositions-history?instType=SWAP&uniqueCode=${uniqueCode}&limit=100${after ? '&after=' + after : ''}`;
    const json = await fetchJSON(url);
    if (!json || json.code !== '0' || !json.data?.length) break;
    total += json.data.length;
    if (json.data.length < 100) break;
    after = json.data[json.data.length - 1].subPosId;
    await sleep(200);
  }
  return total > 0 ? total : null;
}

function decodeTraderName(id) {
  // hex16 format
  if (/^[0-9A-F]{16}$/.test(id)) return { type: 'hex', code: id };
  // numeric (long)
  if (/^\d{15,}$/.test(id)) return { type: 'numeric', code: id };
  // base64 → name
  try {
    const dec = Buffer.from(id, 'base64').toString('utf8');
    if (dec.length >= 2 && /^[\x20-\x7E\u4e00-\u9fa5]+$/.test(dec)) return { type: 'name', name: dec };
  } catch {}
  return { type: 'name', name: id };
}

async function main() {
  console.log('=== OKX Futures Trades Count Enrichment v3 ===\n');

  // ── Load null TC rows ───────────────────────────────────────────────────
  let lrRows = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet(
      `leaderboard_ranks?source=eq.okx_futures&trades_count=is.null&select=id,source_trader_id,season_id&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    lrRows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`LR rows with null trades_count: ${lrRows.length}`);

  // Group by trader
  const traderRowMap = new Map(); // source_trader_id → [row]
  for (const r of lrRows) {
    if (!traderRowMap.has(r.source_trader_id)) traderRowMap.set(r.source_trader_id, []);
    traderRowMap.get(r.source_trader_id).push(r);
  }
  const uniqueTraders = [...traderRowMap.keys()];
  console.log(`Unique traders: ${uniqueTraders.length}\n`);

  // ── Scan OKX leaderboard to find active traders ────────────────────────
  console.log('Scanning OKX leaderboard...');
  const leaderboardMap = new Map(); // uniqueCode → { nickName, winRatio }

  const firstPage = await fetchJSON(`${BASE}/public-lead-traders?instType=SWAP&page=1`);
  const totalPages = parseInt(firstPage?.data?.[0]?.totalPage || 22);
  console.log(`  Total leaderboard pages: ${totalPages}`);

  for (let page = 1; page <= totalPages; page++) {
    const json = page === 1 ? firstPage : await fetchJSON(`${BASE}/public-lead-traders?instType=SWAP&page=${page}`);
    if (!json || json.code !== '0') break;
    const ranks = json.data?.[0]?.ranks || [];
    for (const t of ranks) {
      if (t.uniqueCode) leaderboardMap.set(t.uniqueCode, { nickName: t.nickName, winRatio: t.winRatio });
      if (t.nickName) leaderboardMap.set(t.nickName, { uniqueCode: t.uniqueCode, winRatio: t.winRatio });
    }
    if (page % 5 === 0) process.stdout.write(`  Scanned ${page}/${totalPages} pages, ${leaderboardMap.size / 2} traders\r`);
    await sleep(300);
  }
  console.log(`\n  Leaderboard traders found: ${leaderboardMap.size}`);

  // ── For each LR trader, try to get trades count ────────────────────────
  let updated = 0, notOnLeaderboard = 0, noHistory = 0;

  for (let i = 0; i < uniqueTraders.length; i++) {
    const traderId = uniqueTraders[i];
    const rows = traderRowMap.get(traderId);
    const decoded = decodeTraderName(traderId);

    // Find the uniqueCode to use
    let uniqueCode = null;
    if (decoded.type === 'hex') {
      uniqueCode = decoded.code;
    } else if (decoded.type === 'name') {
      // Look up by name in leaderboard
      const entry = leaderboardMap.get(decoded.name);
      if (entry?.uniqueCode) uniqueCode = entry.uniqueCode;
    }

    if (!uniqueCode || !leaderboardMap.has(uniqueCode)) {
      notOnLeaderboard++;
      continue;
    }

    // Fetch position history count
    const tc = await getTradesCount(uniqueCode);
    if (tc === null) { noHistory++; continue; }

    // Update all LR rows for this trader
    for (const row of rows) {
      await sbPatch(row.id, { trades_count: tc });
      updated++;
    }
    await sleep(300);

    if ((i + 1) % 10 === 0) {
      console.log(`  [${i + 1}/${uniqueTraders.length}] updated=${updated} notOnLB=${notOnLeaderboard} noHistory=${noHistory}`);
    }
  }

  console.log(`\n✅ OKX TC Results:`);
  console.log(`  Updated rows: ${updated}`);
  console.log(`  Not on current leaderboard: ${notOnLeaderboard}`);
  console.log(`  On leaderboard but no history: ${noHistory}`);
  console.log(`\n⚠ Note: Traders not on current OKX leaderboard have no public TC data.`);

  // ── Verify ───────────────────────────────────────────────────────────────
  const vr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.okx_futures&trades_count=is.null&select=id`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`\n📊 Remaining OKX TC nulls: ${vr.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
