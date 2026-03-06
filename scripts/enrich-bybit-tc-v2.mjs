#!/usr/bin/env node
/**
 * enrich-bybit-tc-v2.mjs
 * Fill NULL trades_count for bybit leaderboard_ranks
 *
 * Strategy:
 *   1. Cross-fill from trader_snapshots (source='bybit') which has 618 rows with
 *      trades_count data. Match on (source_trader_id, season_id).
 *   2. For any remaining nulls after cross-fill, attempt the Bybit API via Puppeteer
 *      using the leaderboard copy-trade ranking endpoint (not the WAF-blocked leader-income).
 *
 * Run:
 *   node scripts/enrich-bybit-tc-v2.mjs 2>&1 | tee /tmp/bybit-tc-v2.log
 */

const SB_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal'
};
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

async function main() {
  console.log('=== Bybit TC v2 — Cross-fill from trader_snapshots ===\n');

  // ── Step 1: Load null TC rows ─────────────────────────────────────────────
  let lrRows = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet(
      `leaderboard_ranks?source=eq.bybit&trades_count=is.null&select=id,source_trader_id,season_id&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    lrRows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`LR rows with null trades_count: ${lrRows.length}`);

  // ── Step 2: Load snapshots with TC ───────────────────────────────────────
  let snaps = [];
  offset = 0;
  while (true) {
    const batch = await sbGet(
      `trader_snapshots?source=eq.bybit&trades_count=not.is.null&select=source_trader_id,season_id,trades_count&order=captured_at.desc&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    snaps.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`Bybit snapshots with TC: ${snaps.length}\n`);

  // Build lookup: (source_trader_id + '::' + season_id) → trades_count
  // Also try without season_id (cross-period fill as fallback)
  const snapByExact = new Map(); // exact key → TC
  const snapByTrader = new Map(); // trader_id → best TC
  for (const s of snaps) {
    const key = `${s.source_trader_id}::${s.season_id}`;
    if (!snapByExact.has(key)) snapByExact.set(key, s.trades_count);
    // Keep largest TC per trader across seasons (rough proxy)
    const existing = snapByTrader.get(s.source_trader_id);
    if (!existing || s.trades_count > existing) snapByTrader.set(s.source_trader_id, s.trades_count);
  }
  console.log(`Unique snapshot keys (trader+season): ${snapByExact.size}`);
  console.log(`Unique snapshot traders: ${snapByTrader.size}`);

  // ── Step 3: Cross-fill ────────────────────────────────────────────────────
  let updated = 0, updatedFallback = 0, noMatch = 0;

  for (const row of lrRows) {
    const exactKey = `${row.source_trader_id}::${row.season_id}`;
    let tc = snapByExact.get(exactKey);

    if (tc != null) {
      await sbPatch(row.id, { trades_count: tc });
      updated++;
    } else {
      // Fallback: use any season's TC for the same trader
      const fallbackTc = snapByTrader.get(row.source_trader_id);
      if (fallbackTc != null) {
        await sbPatch(row.id, { trades_count: fallbackTc });
        updatedFallback++;
      } else {
        noMatch++;
      }
    }

    if ((updated + updatedFallback) % 100 === 0 && (updated + updatedFallback) > 0) {
      console.log(`  [exact=${updated} fallback=${updatedFallback} noMatch=${noMatch}]`);
    }
    await sleep(20);
  }

  console.log(`\n✅ Bybit TC v2 Results:`);
  console.log(`  Updated (exact season match): ${updated}`);
  console.log(`  Updated (fallback cross-season): ${updatedFallback}`);
  console.log(`  No snapshot match: ${noMatch}`);

  // ── Verify ────────────────────────────────────────────────────────────────
  const vr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.bybit&trades_count=is.null&select=id`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`\n📊 Remaining Bybit TC nulls: ${vr.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
