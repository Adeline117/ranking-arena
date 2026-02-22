#!/usr/bin/env node
/**
 * enrich-aevo-wr-mdd-v2.mjs
 * Fill NULL win_rate and max_drawdown for aevo leaderboard_ranks
 *
 * Strategy:
 *   Cross-fill from trader_snapshots (source='aevo') — same source_trader_id + season_id.
 *   trader_snapshots has 1128 rows with win_rate data (pre-fetched from Aevo API).
 *   Aevo's public leaderboard API does NOT expose WR/MDD; per-user stats require auth.
 *   This cross-fill uses only real historical data.
 *
 * Run:
 *   node scripts/enrich-aevo-wr-mdd-v2.mjs 2>&1 | tee /tmp/aevo-wr-mdd.log
 */

const SB_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';
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
  if (!r.ok) {
    const t = await r.text();
    console.error(`  PATCH error ${r.status}: ${t.substring(0, 100)}`);
  }
}

async function main() {
  console.log('=== Aevo WR + MDD Enrichment (cross-fill from trader_snapshots) ===\n');

  // ── Step 1: Load LR rows missing WR or MDD ──────────────────────────────
  let lrRows = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet(
      `leaderboard_ranks?source=eq.aevo&or=(win_rate.is.null,max_drawdown.is.null)&select=id,source_trader_id,season_id,win_rate,max_drawdown&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    lrRows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`LR rows missing WR or MDD: ${lrRows.length}`);
  if (!lrRows.length) { console.log('Nothing to do.'); return; }

  // ── Step 2: Load trader_snapshots with WR/MDD for aevo ──────────────────
  // Fetch ALL snapshots with at least WR or MDD
  // Aggregate: for each (source_trader_id, season_id) pick the most recent snapshot
  let snaps = [];
  offset = 0;
  while (true) {
    const batch = await sbGet(
      `trader_snapshots?source=eq.aevo&or=(win_rate.not.is.null,max_drawdown.not.is.null)&select=source_trader_id,season_id,win_rate,max_drawdown,captured_at&order=captured_at.desc&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    snaps.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`Aevo snapshots with WR or MDD: ${snaps.length}\n`);

  // Build lookup: (source_trader_id::lower + season_id) → { win_rate, max_drawdown }
  // Take first (most recent, due to order=captured_at.desc)
  const snapMap = new Map();
  for (const s of snaps) {
    const key = `${s.source_trader_id?.toLowerCase()}::${s.season_id}`;
    if (!snapMap.has(key)) {
      snapMap.set(key, { win_rate: s.win_rate, max_drawdown: s.max_drawdown });
    } else {
      // Merge: fill missing fields from older snapshots if current has null
      const existing = snapMap.get(key);
      if (existing.win_rate === null && s.win_rate !== null) existing.win_rate = s.win_rate;
      if (existing.max_drawdown === null && s.max_drawdown !== null) existing.max_drawdown = s.max_drawdown;
    }
  }
  console.log(`Unique (trader, season) snapshots: ${snapMap.size}`);

  // ── Step 3: Match and update ─────────────────────────────────────────────
  let updated = 0, skipped = 0, noMatch = 0;

  for (const row of lrRows) {
    const key = `${row.source_trader_id?.toLowerCase()}::${row.season_id}`;
    const snap = snapMap.get(key);
    if (!snap) { noMatch++; continue; }

    const patch = {};
    if (row.win_rate === null && snap.win_rate !== null) patch.win_rate = snap.win_rate;
    if (row.max_drawdown === null && snap.max_drawdown !== null) patch.max_drawdown = snap.max_drawdown;

    if (Object.keys(patch).length === 0) { skipped++; continue; }

    await sbPatch(row.id, patch);
    updated++;

    if (updated % 50 === 0) {
      console.log(`  [${updated} updated / ${noMatch} no-match / ${skipped} skipped]`);
    }
    await sleep(30);
  }

  console.log(`\n✅ Aevo WR + MDD Results:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  No snapshot match: ${noMatch}`);
  console.log(`  Skipped (data already present): ${skipped}`);

  // ── Verify ───────────────────────────────────────────────────────────────
  const vrWr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.aevo&win_rate=is.null&select=id`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
  });
  const vrMdd = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.aevo&max_drawdown=is.null&select=id`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`\n📊 Remaining WR nulls:  ${vrWr.headers.get('content-range')}`);
  console.log(`📊 Remaining MDD nulls: ${vrMdd.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
