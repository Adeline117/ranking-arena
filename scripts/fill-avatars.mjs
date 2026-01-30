#!/usr/bin/env node
/**
 * ⚠️  DEPRECATED — DiceBear avatars are no longer used.
 * Use replace-dicebear-avatars.mjs to replace with platform defaults.
 * Traders without avatars show initials+gradient in the frontend.
 *
 * fill-avatars.mjs — Batch fill missing avatar_url in trader_sources
 *
 * Strategy:
 *   - For all platforms: Generate deterministic DiceBear avatar URLs
 *   - CEX platforms use "shapes" style (professional look)
 *   - On-chain platforms use "identicon" style (crypto/tech look)
 *   - Seed = source_trader_id for deterministic avatars
 *
 * DiceBear API: https://api.dicebear.com/9.x/{style}/svg?seed={seed}
 * These are stable URLs — same seed always produces the same avatar.
 *
 * Usage: node scripts/fill-avatars.mjs [--dry-run] [--source=xxx] [--limit=N]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// ── Config ──────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DRY_RUN = process.argv.includes('--dry-run');
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null;
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0;

// DiceBear styles per platform category
const ONCHAIN_SOURCES = ['gmx', 'hyperliquid', 'dydx', 'okx_web3', 'binance_web3'];
const DICEBEAR_BASE = 'https://api.dicebear.com/9.x';

/**
 * Generate a DiceBear avatar URL for a trader
 */
function generateAvatarUrl(source, sourceTraderIdOrHandle) {
  const style = ONCHAIN_SOURCES.includes(source) ? 'identicon' : 'shapes';
  // Use the trader ID as seed for deterministic generation
  const seed = encodeURIComponent(sourceTraderIdOrHandle);
  return `${DICEBEAR_BASE}/${style}/svg?seed=${seed}&size=128`;
}

/**
 * Fetch all traders missing avatar_url for a given source
 */
async function fetchMissingAvatars(source) {
  const PAGE_SIZE = 1000;
  let allRecords = [];
  let from = 0;

  while (true) {
    let query = supabase
      .from('trader_sources')
      .select('id, source, source_trader_id, handle')
      .eq('source', source)
      .is('avatar_url', null)
      .range(from, from + PAGE_SIZE - 1);

    if (LIMIT > 0 && allRecords.length + PAGE_SIZE > LIMIT) {
      query = supabase
        .from('trader_sources')
        .select('id, source, source_trader_id, handle')
        .eq('source', source)
        .is('avatar_url', null)
        .range(from, from + (LIMIT - allRecords.length) - 1);
    }

    const { data, error } = await query;

    if (error) {
      console.error(`  ❌ Error fetching ${source}:`, error.message);
      break;
    }

    if (!data || data.length === 0) break;

    allRecords = allRecords.concat(data);

    if (data.length < PAGE_SIZE || (LIMIT > 0 && allRecords.length >= LIMIT)) break;
    from += PAGE_SIZE;
  }

  return allRecords;
}

/**
 * Batch update avatar_url for traders
 */
async function batchUpdateAvatars(updates) {
  if (updates.length === 0) return 0;

  const BATCH_SIZE = 100;
  let updated = 0;

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);

    // Use individual updates grouped (Supabase JS doesn't support batch upsert by different IDs easily)
    // We'll use Promise.all with individual updates for efficiency
    const promises = batch.map(({ id, avatar_url }) =>
      supabase
        .from('trader_sources')
        .update({ avatar_url })
        .eq('id', id)
        .is('avatar_url', null) // Safety: don't overwrite existing
    );

    const results = await Promise.all(promises);
    const succeeded = results.filter(r => !r.error).length;
    updated += succeeded;

    if (results.some(r => r.error)) {
      const errors = results.filter(r => r.error);
      console.error(`    ⚠ ${errors.length} errors in batch ${Math.floor(i / BATCH_SIZE) + 1}`);
    }
  }

  return updated;
}

/**
 * Validate a DiceBear URL is accessible (sample check)
 */
async function validateDiceBearApi() {
  const testUrl = `${DICEBEAR_BASE}/shapes/svg?seed=test123&size=128`;
  try {
    const res = await fetch(testUrl, { method: 'HEAD' });
    if (!res.ok) {
      console.error(`❌ DiceBear API returned ${res.status} — aborting`);
      process.exit(1);
    }
    console.log('✅ DiceBear API is accessible\n');
  } catch (e) {
    console.error('❌ Cannot reach DiceBear API:', e.message);
    process.exit(1);
  }
}

/**
 * Get coverage stats using RPC or raw counts
 */
async function getCoverageStats() {
  // Get all distinct sources via a targeted query
  const ALL_SOURCES = [
    'binance_futures', 'bitget_futures', 'mexc', 'kucoin', 'coinex',
    'binance_web3', 'bitget_spot', 'xt', 'gmx', 'okx_web3', 'lbank',
    'bybit', 'htx', 'phemex', 'weex', 'bitmart', 'dydx', 'hyperliquid',
    'nansen', 'okx',
  ];

  const stats = {};

  for (const src of ALL_SOURCES) {
    const { count: total } = await supabase
      .from('trader_sources')
      .select('id', { count: 'exact', head: true })
      .eq('source', src);

    if (!total || total === 0) continue;

    const { count: withAvatar } = await supabase
      .from('trader_sources')
      .select('id', { count: 'exact', head: true })
      .eq('source', src)
      .not('avatar_url', 'is', null);

    stats[src] = { total, withAvatar: withAvatar || 0, missing: total - (withAvatar || 0) };
  }

  return stats;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('=== 🖼️  Fill Missing Avatars ===');
  console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN' : '✏️  LIVE'}`);
  if (SOURCE_FILTER) console.log(`Filter: source=${SOURCE_FILTER}`);
  if (LIMIT) console.log(`Limit: ${LIMIT} per source`);
  console.log('');

  // Validate DiceBear API
  await validateDiceBearApi();

  // Get current stats
  console.log('📊 Current coverage:');
  const stats = await getCoverageStats();
  const sortedSources = Object.entries(stats).sort((a, b) => b[1].missing - a[1].missing);

  for (const [src, s] of sortedSources) {
    if (s.missing === 0) continue;
    const pct = s.total > 0 ? Math.round((s.withAvatar / s.total) * 100) : 0;
    console.log(`  ${src}: ${s.withAvatar}/${s.total} (${pct}%) — ${s.missing} missing`);
  }
  console.log('');

  // Process each source
  const sourcesToProcess = SOURCE_FILTER
    ? [SOURCE_FILTER]
    : sortedSources.filter(([, s]) => s.missing > 0).map(([src]) => src);

  let totalUpdated = 0;

  for (const source of sourcesToProcess) {
    const missing = stats[source]?.missing || 0;
    if (missing === 0) {
      console.log(`⏭️  ${source}: no missing avatars`);
      continue;
    }

    console.log(`🔄 ${source}: fetching ${missing} traders without avatar...`);
    const traders = await fetchMissingAvatars(source);
    console.log(`   Found ${traders.length} records`);

    if (traders.length === 0) continue;

    // Generate avatar URLs
    const updates = traders.map(t => ({
      id: t.id,
      avatar_url: generateAvatarUrl(source, t.source_trader_id || t.handle),
    }));

    // Show samples
    console.log('   Samples:');
    for (const u of updates.slice(0, 3)) {
      const trader = traders.find(t => t.id === u.id);
      console.log(`     ${trader.handle || trader.source_trader_id} → ${u.avatar_url.substring(0, 80)}...`);
    }

    if (DRY_RUN) {
      console.log(`   ⏩ DRY RUN: would update ${updates.length} records\n`);
      continue;
    }

    // Execute batch update
    const updated = await batchUpdateAvatars(updates);
    console.log(`   ✅ Updated ${updated}/${updates.length} records\n`);
    totalUpdated += updated;
  }

  // Final stats
  console.log('═══════════════════════════════════════');
  if (DRY_RUN) {
    console.log('🔍 DRY RUN complete — no changes made');
  } else {
    console.log(`✅ Total updated: ${totalUpdated} avatar URLs`);

    // Show new coverage
    console.log('\n📊 New coverage:');
    const newStats = await getCoverageStats();
    for (const [src, s] of Object.entries(newStats).sort((a, b) => b[1].missing - a[1].missing)) {
      const pct = s.total > 0 ? Math.round((s.withAvatar / s.total) * 100) : 0;
      const old = stats[src];
      const gain = old ? s.withAvatar - old.withAvatar : 0;
      const gainStr = gain > 0 ? ` (+${gain})` : '';
      console.log(`  ${src}: ${s.withAvatar}/${s.total} (${pct}%)${gainStr}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
