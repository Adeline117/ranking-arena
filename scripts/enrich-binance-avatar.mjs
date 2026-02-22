#!/usr/bin/env node
/**
 * enrich-binance-avatar.mjs
 * Fill NULL avatar_url for binance_futures leaderboard_ranks
 * 
 * Strategy:
 * 1. Cross-fill from trader_sources (fast, no API needed)
 * 2. Fetch from Binance copy trading API via mihomo proxy (port 7890)
 *    API: GET /bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=X
 * 3. Only real avatar URLs are saved (no placeholder/dicebear)
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const SB_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';
const SB_HDR = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal'
};
const PROXY = 'http://127.0.0.1:7890';
const CONCURRENCY = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FAKE_PATTERNS = ['boringavatars', 'dicebear', 'identicon', 'default-avatar', 'placeholder'];
const isRealAvatar = url => url && url.startsWith('http') && !FAKE_PATTERNS.some(p => url.includes(p));

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HDR });
  if (!r.ok) throw new Error(`SB ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbPatch(id, data) {
  const r = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?id=eq.${id}`, {
    method: 'PATCH', headers: SB_HDR, body: JSON.stringify(data)
  });
  if (!r.ok) console.error('Patch error', r.status);
}

async function fetchBinanceAvatar(portfolioId) {
  try {
    const { stdout } = await execAsync(
      `curl -s --max-time 10 -x ${PROXY} --compressed 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${portfolioId}' -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' -H 'Origin: https://www.binance.com' -H 'Referer: https://www.binance.com/en/copy-trading'`,
      { timeout: 15000 }
    );
    const json = JSON.parse(stdout);
    if (!json?.success) return null; // Closed portfolio or error
    const url = json?.data?.avatarUrl || json?.data?.userPhotoUrl;
    return isRealAvatar(url) ? url : null;
  } catch { return null; }
}

async function main() {
  console.log('=== Binance Futures Avatar Enrichment ===\n');

  // 1. Test proxy
  try {
    const { stdout } = await execAsync(`curl -s --max-time 5 -x ${PROXY} https://ipinfo.io/ip`, { timeout: 8000 });
    console.log(`✓ Proxy working (IP: ${stdout.trim()})`);
  } catch {
    console.log('⚠ Proxy check failed, continuing anyway...');
  }

  // 2. Get all LR rows missing avatar
  let allRows = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet(
      `leaderboard_ranks?source=eq.binance_futures&avatar_url=is.null&select=id,source_trader_id&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    allRows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`DB rows missing avatar: ${allRows.length}`);
  if (!allRows.length) { console.log('Nothing to do.'); return; }

  // 3. Cross-fill from trader_sources
  console.log('\n--- Step 1: Cross-fill from trader_sources ---');
  const tsRows = await sbGet(
    `trader_sources?source=eq.binance_futures&avatar_url=not.is.null&select=source_trader_id,avatar_url&limit=5000`
  );
  const tsMap = new Map(
    tsRows.filter(r => isRealAvatar(r.avatar_url)).map(r => [r.source_trader_id, r.avatar_url])
  );
  console.log(`trader_sources with real avatars: ${tsMap.size}`);

  let crossFilled = 0;
  const stillMissing = [];
  for (const row of allRows) {
    const avatar = tsMap.get(row.source_trader_id);
    if (avatar) {
      await sbPatch(row.id, { avatar_url: avatar });
      crossFilled++;
    } else {
      stillMissing.push(row);
    }
  }
  console.log(`Cross-filled: ${crossFilled} rows`);

  // 4. Fetch from API for remaining
  console.log(`\n--- Step 2: Fetch from Binance API (${stillMissing.length} remaining) ---`);
  
  // Deduplicate by portfolio_id
  const byPortfolio = new Map();
  for (const row of stillMissing) {
    if (!byPortfolio.has(row.source_trader_id)) byPortfolio.set(row.source_trader_id, []);
    byPortfolio.get(row.source_trader_id).push(row.id);
  }
  const portfolios = [...byPortfolio.keys()];
  console.log(`Unique portfolio IDs: ${portfolios.length}`);

  let apiFetched = 0, apiClosed = 0, apiUpdated = 0;

  for (let i = 0; i < portfolios.length; i += CONCURRENCY) {
    const batch = portfolios.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async pid => {
      const avatar = await fetchBinanceAvatar(pid);
      return { pid, avatar };
    }));

    for (const { pid, avatar } of results) {
      apiFetched++;
      if (!avatar) { apiClosed++; continue; }
      const ids = byPortfolio.get(pid) || [];
      for (const id of ids) {
        await sbPatch(id, { avatar_url: avatar });
        apiUpdated++;
      }
    }

    const done = Math.min(i + CONCURRENCY, portfolios.length);
    if (done % 100 === 0 || done === portfolios.length) {
      console.log(`  [${done}/${portfolios.length}] fetched=${apiFetched} closed=${apiClosed} updated=${apiUpdated}`);
    }
    await sleep(300);
  }

  console.log(`\n✅ Binance Avatar Results:`);
  console.log(`  Cross-filled: ${crossFilled}`);
  console.log(`  API fetched: ${apiFetched}, closed/failed: ${apiClosed}, updated: ${apiUpdated}`);
  console.log(`  Total updated: ${crossFilled + apiUpdated}`);

  // Verify
  const vr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.binance_futures&avatar_url=is.null&select=id`, {
    headers: { ...SB_HDR, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`\n📊 Remaining avatar nulls: ${vr.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
