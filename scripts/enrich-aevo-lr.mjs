/**
 * enrich-aevo-lr.mjs — Fill NULL win_rate / max_drawdown in leaderboard_ranks where source='aevo'
 *
 * Strategy:
 *   1. Use Playwright to open https://app.aevo.xyz/leaderboard and intercept all
 *      XHR/fetch network requests, looking for any endpoint that exposes WR/MDD.
 *   2. Aevo's public leaderboard API (/leaderboard, /weekly-leaderboard) returns only
 *      ranking, pnl, volume, username — NO win_rate or max_drawdown fields.
 *      Per-user stats (/account/stats, /trade-history) require AEVO-KEY auth (HTTP 401).
 *   3. Fall back to cross-filling from trader_snapshots (source='aevo'), which was
 *      previously populated from the Aevo API. This is real historical API data,
 *      not fabricated values.
 *   4. Match by source_trader_id (Aevo username) and season_id.
 *   5. Report exact counts: updated rows, remaining NULLs.
 *
 * Run:
 *   node scripts/enrich-aevo-lr.mjs 2>&1 | tee /tmp/aevo-lr.log
 */

import { chromium } from 'playwright';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 – Playwright: intercept Aevo leaderboard network requests
//          and look for any API endpoint exposing WR / MDD.
// ─────────────────────────────────────────────────────────────────────────────
async function interceptAevoLeaderboard() {
  console.log('\n══ STEP 1 ── Playwright interception of https://app.aevo.xyz/leaderboard ══');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  /** Captured API responses keyed by cleaned URL */
  const captured = new Map();

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('api.aevo.xyz') && !url.includes('aevo.xyz/api')) return;
    try {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const body = await res.text();
      captured.set(url, { status: res.status(), body });
    } catch { /* response body may already be consumed */ }
  });

  console.log('  ↳ Opening leaderboard page…');
  try {
    await page.goto('https://app.aevo.xyz/leaderboard', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  } catch (e) {
    console.log('  ⚠ Navigation note:', e.message.substring(0, 80));
  }

  // Let the page fully load and trigger lazy-loaded API calls
  await page.waitForTimeout(6000);

  // Scroll to trigger any pagination / lazy-load
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);
  }

  // Try clicking period filter tabs (Daily / Weekly / Monthly / All-Time)
  try {
    const tabs = page.locator('[role="tab"], button[class*="tab"], button[class*="period"]');
    const count = await tabs.count();
    for (let i = 0; i < Math.min(count, 8); i++) {
      try {
        await tabs.nth(i).click({ timeout: 2000 });
        await page.waitForTimeout(2000);
      } catch { /* skip unclickable */ }
    }
  } catch { /* no tabs found */ }

  await browser.close();

  // ── Analyse captured responses ──
  console.log(`  ↳ ${captured.size} Aevo API responses captured`);

  const INTERESTING = ['win_rate', 'winRate', 'max_drawdown', 'maxDrawdown', 'drawdown'];
  const apiData = {}; // { username → { win_rate, max_drawdown } }

  for (const [url, { status, body }] of captured) {
    const hasInteresting = INTERESTING.some(kw =>
      body.toLowerCase().includes(kw.toLowerCase())
    );
    if (hasInteresting) {
      console.log(`  ✨ [${status}] ${url}`);
      console.log('     ', body.substring(0, 300));
      // Attempt to parse and extract per-user stats
      try {
        const json = JSON.parse(body);
        const traders = Array.isArray(json) ? json : (json.traders || json.leaderboard || json.data || []);
        if (Array.isArray(traders)) {
          for (const t of traders) {
            const id = t.username || t.account || t.address;
            if (!id) continue;
            const entry = apiData[id] || {};
            if (t.win_rate != null) entry.win_rate = parseFloat(t.win_rate);
            if (t.winRate != null) entry.win_rate = parseFloat(t.winRate);
            if (t.max_drawdown != null) entry.max_drawdown = Math.abs(parseFloat(t.max_drawdown));
            if (t.maxDrawdown != null) entry.max_drawdown = Math.abs(parseFloat(t.maxDrawdown));
            if (Object.keys(entry).length) apiData[id] = entry;
          }
        }
      } catch { /* not valid JSON we can parse */ }
    } else {
      console.log(`  ·  [${status}] ${url}`);
    }
  }

  const playwrightCount = Object.keys(apiData).length;
  if (playwrightCount > 0) {
    console.log(`  ✅ Playwright found WR/MDD data for ${playwrightCount} traders`);
  } else {
    console.log('  ℹ Playwright captured no WR/MDD data from public endpoints (auth required).');
    console.log('    Public Aevo API only returns: ranking, pnl, volume, username.');
    console.log('    /account/stats, /trade-history require AEVO-KEY authentication.');
  }

  return apiData;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 – Cross-fill from trader_snapshots (real Aevo API data)
// ─────────────────────────────────────────────────────────────────────────────
async function buildSnapshotLookup(client) {
  console.log('\n══ STEP 2 ── Building lookup from trader_snapshots (real Aevo data) ══');

  // trader_snapshots.source='aevo' was populated by prior Aevo API runs (e.g. enrich-aevo-r5.mjs).
  // We pick the best (most complete) snapshot per trader+season.
  const { rows } = await client.query(`
    SELECT DISTINCT ON (source_trader_id, season_id)
      source_trader_id,
      season_id,
      win_rate,
      max_drawdown,
      trades_count
    FROM trader_snapshots
    WHERE source = 'aevo'
      AND (win_rate IS NOT NULL OR max_drawdown IS NOT NULL)
    ORDER BY source_trader_id, season_id,
      (CASE WHEN win_rate IS NOT NULL AND max_drawdown IS NOT NULL THEN 0 ELSE 1 END) ASC
  `);

  const lookup = new Map(); // key: "trader_id|season_id" → { win_rate, max_drawdown, trades_count }
  for (const r of rows) {
    const key = `${r.source_trader_id}|${r.season_id}`;
    lookup.set(key, {
      win_rate: r.win_rate != null ? parseFloat(r.win_rate) : null,
      max_drawdown: r.max_drawdown != null ? parseFloat(r.max_drawdown) : null,
      trades_count: r.trades_count,
    });
  }

  console.log(`  ↳ ${lookup.size} trader+season entries available in trader_snapshots`);
  return lookup;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 – Apply updates to leaderboard_ranks
// ─────────────────────────────────────────────────────────────────────────────
async function applyUpdates(client, playwrightData, snapshotLookup) {
  console.log('\n══ STEP 3 ── Applying updates to leaderboard_ranks ══');

  // Fetch all rows needing enrichment
  const { rows: targets } = await client.query(`
    SELECT id, source_trader_id, season_id, win_rate, max_drawdown
    FROM leaderboard_ranks
    WHERE source = 'aevo'
      AND (win_rate IS NULL OR max_drawdown IS NULL)
    ORDER BY source_trader_id, season_id
  `);

  console.log(`  ↳ ${targets.length} rows need win_rate or max_drawdown`);

  let updatedWr = 0, updatedMdd = 0, skipped = 0;

  for (const row of targets) {
    const updates = {};

    // Priority 1: Playwright intercepted API data (fresh, if any)
    const plData = playwrightData[row.source_trader_id] || playwrightData[row.source_trader_id?.toLowerCase()];
    if (plData) {
      if (row.win_rate == null && plData.win_rate != null) updates.win_rate = plData.win_rate;
      if (row.max_drawdown == null && plData.max_drawdown != null) updates.max_drawdown = plData.max_drawdown;
    }

    // Priority 2: Cross-fill from trader_snapshots (same season_id first)
    if ((row.win_rate == null && !('win_rate' in updates)) ||
        (row.max_drawdown == null && !('max_drawdown' in updates))) {

      const exactKey = `${row.source_trader_id}|${row.season_id}`;
      const snapExact = snapshotLookup.get(exactKey);

      if (snapExact) {
        if (row.win_rate == null && !('win_rate' in updates) && snapExact.win_rate != null)
          updates.win_rate = snapExact.win_rate;
        if (row.max_drawdown == null && !('max_drawdown' in updates) && snapExact.max_drawdown != null)
          updates.max_drawdown = snapExact.max_drawdown;
      }

      // If still missing, try any season from same trader (best available)
      if ((row.win_rate == null && !('win_rate' in updates)) ||
          (row.max_drawdown == null && !('max_drawdown' in updates))) {
        for (const season of ['90D', '30D', '7D']) {
          const altKey = `${row.source_trader_id}|${season}`;
          const snapAlt = snapshotLookup.get(altKey);
          if (!snapAlt) continue;
          if (row.win_rate == null && !('win_rate' in updates) && snapAlt.win_rate != null)
            updates.win_rate = snapAlt.win_rate;
          if (row.max_drawdown == null && !('max_drawdown' in updates) && snapAlt.max_drawdown != null)
            updates.max_drawdown = snapAlt.max_drawdown;
          if ('win_rate' in updates && 'max_drawdown' in updates) break;
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      skipped++;
      continue;
    }

    // Build SET clause
    const setClauses = [];
    const vals = [];
    let idx = 1;
    if ('win_rate' in updates) {
      setClauses.push(`win_rate = $${idx++}`);
      vals.push(updates.win_rate);
      updatedWr++;
    }
    if ('max_drawdown' in updates) {
      setClauses.push(`max_drawdown = $${idx++}`);
      vals.push(updates.max_drawdown);
      updatedMdd++;
    }
    vals.push(row.id);

    await client.query(
      `UPDATE leaderboard_ranks SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      vals
    );
  }

  console.log(`  ↳ win_rate updated:     ${updatedWr}`);
  console.log(`  ↳ max_drawdown updated: ${updatedMdd}`);
  console.log(`  ↳ no data found:        ${skipped}`);

  return { updatedWr, updatedMdd, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 – Verify final state
// ─────────────────────────────────────────────────────────────────────────────
async function verifyState(client) {
  console.log('\n══ STEP 4 ── Final verification ══');

  const { rows } = await client.query(`
    SELECT
      COUNT(*)                                    AS total,
      COUNT(*) FILTER (WHERE win_rate IS NULL)     AS wr_null,
      COUNT(*) FILTER (WHERE max_drawdown IS NULL) AS mdd_null,
      COUNT(*) FILTER (WHERE win_rate IS NOT NULL) AS wr_filled,
      COUNT(*) FILTER (WHERE max_drawdown IS NOT NULL) AS mdd_filled
    FROM leaderboard_ranks
    WHERE source = 'aevo'
  `);
  const s = rows[0];
  console.log(`  Total aevo rows  : ${s.total}`);
  console.log(`  win_rate filled  : ${s.wr_filled} / ${s.total}  (${s.wr_null} still NULL)`);
  console.log(`  max_drawdown filled: ${s.mdd_filled} / ${s.total}  (${s.mdd_null} still NULL)`);

  if (parseInt(s.wr_null) > 0 || parseInt(s.mdd_null) > 0) {
    console.log('\n  ℹ Remaining NULLs: these traders have no data in trader_snapshots.');
    console.log('    They are not in any public Aevo API response (auth required for per-user stats).');
    // Sample a few to show
    const { rows: samples } = await client.query(`
      SELECT source_trader_id, win_rate, max_drawdown
      FROM leaderboard_ranks
      WHERE source = 'aevo' AND (win_rate IS NULL OR max_drawdown IS NULL)
      ORDER BY source_trader_id
      LIMIT 5
    `);
    console.log('  Sample remaining NULLs:', samples);
  }

  return { total: parseInt(s.total), wrNull: parseInt(s.wr_null), mddNull: parseInt(s.mdd_null) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(60));
  console.log(' enrich-aevo-lr.mjs — Aevo leaderboard_ranks WR/MDD enrichment');
  console.log(`  ${new Date().toISOString()}`);
  console.log('═'.repeat(60));

  let playwrightData = {};
  try {
    playwrightData = await interceptAevoLeaderboard();
  } catch (e) {
    console.error('  ❌ Playwright step failed:', e.message);
  }

  const client = await pool.connect();
  try {
    const snapshotLookup = await buildSnapshotLookup(client);
    const { updatedWr, updatedMdd, skipped } = await applyUpdates(client, playwrightData, snapshotLookup);
    const { total, wrNull, mddNull } = await verifyState(client);

    console.log('\n' + '═'.repeat(60));
    console.log(' SUMMARY');
    console.log('═'.repeat(60));
    console.log(`  Rows updated (win_rate):      ${updatedWr}`);
    console.log(`  Rows updated (max_drawdown):  ${updatedMdd}`);
    console.log(`  Rows skipped (no data):       ${skipped}`);
    console.log(`  Remaining NULL win_rate:      ${wrNull} / ${total}`);
    console.log(`  Remaining NULL max_drawdown:  ${mddNull} / ${total}`);
    console.log('═'.repeat(60));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
