#!/usr/bin/env node
/**
 * backfill-hl-mdd.mjs — Compute max_drawdown for Hyperliquid traders
 * 
 * Fetches userFills from Hyperliquid API, computes cumulative PnL,
 * then calculates MDD (max drawdown) as percentage from peak.
 * 
 * Usage: node scripts/backfill-hl-mdd.mjs [--dry-run] [--limit=N]
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '9999');
const DELAY_MS = parseInt(process.argv.find(a => a.startsWith('--delay='))?.split('=')[1] || '2500');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function sbFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, { headers: { ...headers, ...opts.headers }, ...opts });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res;
}

async function getTradersMissingMDD() {
  // Get distinct source_trader_ids with null max_drawdown
  const res = await sbFetch(
    'trader_snapshots?source=eq.hyperliquid&max_drawdown=is.null&select=source_trader_id'
  );
  const data = await res.json();
  const unique = [...new Set(data.map(d => d.source_trader_id))];
  return unique.slice(0, LIMIT);
}

async function fetchHLFills(address) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'userFills', user: address }),
  });
  if (!res.ok) throw new Error(`HL API ${res.status}`);
  return res.json();
}

function computeMDD(fills) {
  // Filter perp fills (not spot dust), sort by time
  const perpFills = fills
    .filter(f => f.dir !== 'Spot Dust Conversion' && !f.coin.startsWith('@'))
    .sort((a, b) => a.time - b.time);

  if (perpFills.length === 0) return null;

  // Compute cumulative PnL
  let cumPnl = 0;
  let peak = 0;
  let maxDD = 0;

  for (const fill of perpFills) {
    cumPnl += parseFloat(fill.closedPnl || '0');
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // Return MDD as percentage of peak (if peak > 0)
  if (peak <= 0) {
    // All losing, MDD = 100% or use absolute
    return maxDD > 0 ? -100 : 0;
  }
  
  const mddPct = -Math.round((maxDD / peak) * 10000) / 100; // negative percentage
  return Math.max(mddPct, -100); // cap at -100%
}

async function updateMDD(traderAddr, mdd) {
  if (DRY_RUN) return 0;
  
  const res = await sbFetch(
    `trader_snapshots?source=eq.hyperliquid&source_trader_id=eq.${traderAddr}&max_drawdown=is.null`,
    {
      method: 'PATCH',
      body: JSON.stringify({ max_drawdown: mdd }),
      headers: { ...headers, Prefer: 'return=minimal' },
    }
  );
  return 1;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`\n🔄 Hyperliquid MDD Backfill ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`   Delay: ${DELAY_MS}ms per request\n`);

  const traders = await getTradersMissingMDD();
  console.log(`📊 ${traders.length} traders missing MDD\n`);

  let updated = 0, errors = 0, skipped = 0;

  for (let i = 0; i < traders.length; i++) {
    const addr = traders[i];
    try {
      const fills = await fetchHLFills(addr);
      const mdd = computeMDD(fills);
      
      if (mdd === null || mdd === 0) {
        console.log(`  [${i+1}/${traders.length}] ${addr.slice(0,10)}... no perp fills, skip`);
        // Set to 0 so we don't retry
        await updateMDD(addr, 0);
        skipped++;
      } else {
        await updateMDD(addr, mdd);
        console.log(`  [${i+1}/${traders.length}] ${addr.slice(0,10)}... MDD=${mdd}%`);
        updated++;
      }

      if ((i + 1) % 50 === 0) {
        console.log(`\n  --- Progress: ${i+1}/${traders.length} (${updated} updated, ${skipped} skipped, ${errors} errors) ---\n`);
      }

      await sleep(DELAY_MS);
    } catch (e) {
      console.log(`  [${i+1}/${traders.length}] ${addr.slice(0,10)}... ERROR: ${e.message}`);
      errors++;
      await sleep(DELAY_MS * 2); // extra delay on error
    }
  }

  console.log(`\n✅ Done: ${updated} updated, ${skipped} skipped, ${errors} errors`);
}

main().catch(e => { console.error(e); process.exit(1); });
