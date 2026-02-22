#!/usr/bin/env node
/**
 * enrich-crossfill-avatars.mjs
 * Cross-fill avatar_url from trader_sources → leaderboard_ranks for all platforms
 * Fast operation: only DB queries, no API calls
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

const FAKE = ['deadpool', 'dicebear', 'boringavatar', 'identicon', 'placeholder', 'default_avatar', 'avatar1.8fc6058c'];
const isReal = url => url && url.startsWith('http') && !FAKE.some(p => url.includes(p));

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`SB ${r.status}`);
  return r.json();
}

async function sbPatch(id, data) {
  const r = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?id=eq.${id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify(data)
  });
  if (!r.ok) console.error('Patch error', r.status);
}

async function crossFillPlatform(source) {
  // Get LR rows missing avatar
  let lrRows = [];
  let off = 0;
  while (true) {
    const batch = await sbGet(`leaderboard_ranks?source=eq.${source}&avatar_url=is.null&select=id,source_trader_id&limit=1000&offset=${off}`);
    if (!batch?.length) break;
    lrRows.push(...batch);
    if (batch.length < 1000) break;
    off += 1000;
  }
  if (!lrRows.length) return 0;

  // Get trader_sources with avatars
  let tsRows = [];
  off = 0;
  while (true) {
    const batch = await sbGet(`trader_sources?source=eq.${source}&avatar_url=not.is.null&select=source_trader_id,avatar_url&limit=2000&offset=${off}`);
    if (!batch?.length) break;
    tsRows.push(...batch);
    if (batch.length < 2000) break;
    off += 2000;
  }

  const tsMap = new Map(tsRows.filter(r => isReal(r.avatar_url)).map(r => [r.source_trader_id, r.avatar_url]));
  
  let updated = 0;
  for (const row of lrRows) {
    const avatar = tsMap.get(row.source_trader_id);
    if (!avatar) continue;
    await sbPatch(row.id, { avatar_url: avatar });
    updated++;
  }
  return updated;
}

async function main() {
  console.log('=== Cross-fill Avatars: trader_sources → leaderboard_ranks ===\n');
  
  const sources = [
    'binance_futures', 'bybit', 'bybit_spot', 'bitget_futures', 'bitget_spot',
    'mexc', 'okx_futures', 'htx_futures', 'aevo'
  ];
  
  let total = 0;
  for (const source of sources) {
    const n = await crossFillPlatform(source);
    if (n > 0) console.log(`  ${source}: +${n}`);
    total += n;
    await sleep(500);
  }
  
  console.log(`\n✅ Total cross-filled: ${total}`);
  
  // Final status
  console.log('\n📊 Final null counts:');
  for (const source of sources) {
    const r = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.${source}&avatar_url=is.null&select=id`, {
      headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
    });
    const cr = r.headers.get('content-range');
    const count = parseInt((cr || '0/0').split('/')[1]);
    if (count > 0) console.log(`  ${source}: ${count} remaining`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
