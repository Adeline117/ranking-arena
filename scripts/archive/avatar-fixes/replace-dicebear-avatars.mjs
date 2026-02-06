#!/usr/bin/env node
/**
 * replace-dicebear-avatars.mjs — Replace DiceBear avatars with platform defaults
 *
 * For CEX platforms: use the platform's own default avatar image
 * For on-chain platforms: set to null (frontend shows initials+gradient)
 *
 * Usage: node scripts/replace-dicebear-avatars.mjs [--dry-run]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const DRY_RUN = process.argv.includes('--dry-run');

// ── Platform default avatar URLs ──────────────────────────────────
// These are the actual default avatars used on each platform's website.

const PLATFORM_DEFAULTS = {
  // CEX platforms — use their official default avatar
  bybit: 'https://s1.bycsi.com/bybit/deadpool/image-f917004e66dc4ee9811dead815813194.svg',
  binance_futures: 'https://bin.bnbstatic.com/static/images/copytrading/default-avatar.png',
  binance_web3: 'https://bin.bnbstatic.com/static/images/copytrading/default-avatar.png',
  mexc: 'https://static.mocortech.com/futures-v3/_next/static/assets/img/avatar1.8fc6058c.png',
  kucoin: 'https://assets.staticimg.com/kc-v2-config/avatar/672a0c9a58fbd5000157bbe4_3.png',
  coinex: 'https://file.coinexstatic.com/avatar-webp/coinex_default_avatar_base.webp',
  htx_futures: 'https://download.hbfile.net/hbg/img/202507111806/c3f9ae8e380948c79e95f87e9f9ea64e/4614a1a930c4026f3b7d0775cc667e2e.png',
  lbank: null, // no default found; set null → frontend shows initials
  xt: null,    // no connector; set null → frontend shows initials
  bingx: null,
  blofin: null,
  phemex: null,
  weex: null,
  bitget: null,
  bitmart: null,

  // On-chain platforms — no avatars exist; set null → frontend shows initials
  hyperliquid: null,
  gmx: null,
  dydx: null,
  gains: null,
  binance_web3_onchain: null,
};

// ── Main ──────────────────────────────────────────

async function replaceDiceBear(source, newAvatarUrl) {
  // Count first
  const { count } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })
    .eq('source', source)
    .like('avatar_url', '%dicebear%');

  if (!count) {
    console.log(`  ${source}: 0 DiceBear → skip`);
    return 0;
  }

  console.log(`  ${source}: ${count} DiceBear → ${newAvatarUrl ? 'platform default' : 'null (initials)'}`);

  if (DRY_RUN) return count;

  // Update in batches (Supabase has no batch limit on update with filter)
  const { error, count: updated } = await supabase
    .from('trader_sources')
    .update({ avatar_url: newAvatarUrl })
    .eq('source', source)
    .like('avatar_url', '%dicebear%');

  if (error) {
    console.error(`    ❌ Error: ${error.message}`);
    return 0;
  }

  console.log(`    ✅ Updated ${updated ?? count}`);
  return count;
}

async function main() {
  console.log(`\n🔄 Replace DiceBear Avatars ${DRY_RUN ? '(DRY RUN)' : ''}\n`);

  let total = 0;
  for (const [source, defaultUrl] of Object.entries(PLATFORM_DEFAULTS)) {
    total += await replaceDiceBear(source, defaultUrl);
  }

  console.log(`\n✅ Total: ${total} DiceBear avatars replaced\n`);
}

main().catch(console.error);
