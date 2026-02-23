#!/usr/bin/env node
/**
 * enrich-bybit-tc.mjs - v3
 * Fill NULL trades_count for bybit leaderboard_ranks
 * 
 * Bybit leader-income API returns:
 * - cumTradeCount: total trades (cumulative across all time)
 * - sevenDayProfitWinRateE4: 7D win rate
 * - thirtyDayProfitWinRateE4: 30D win rate
 * - Note: period-specific WinCount/LossCount fields no longer in API
 * 
 * We use cumTradeCount as the trades_count value (real exchange data).
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

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
  if (!r.ok) throw new Error(`SB ${r.status}`);
  return r.json();
}

async function sbPatch(id, data) {
  const r = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?id=eq.${id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify(data)
  });
  if (!r.ok) console.error('Patch error', r.status);
}

async function main() {
  console.log('=== Bybit TC Enrichment (cumTradeCount) ===\n');

  // Get rows missing TC
  let allRows = [];
  let offset = 0;
  while (true) {
    const batch = await sbGet(
      `leaderboard_ranks?source=eq.bybit&trades_count=is.null&select=id,source_trader_id,season_id&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    allRows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`DB rows missing TC: ${allRows.length}`);
  if (!allRows.length) { console.log('Nothing to do.'); return; }

  // Group by trader
  const traderMap = new Map();
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, []);
    traderMap.get(r.source_trader_id).push(r);
  }
  // Only valid leaderMarks (base64 with special chars)
  const traders = [...traderMap.keys()].filter(
    id => id.includes('==') || id.includes('+') || id.includes('/') || (id.length > 15 && !/^\d+$/.test(id))
  );
  console.log(`Unique valid marks: ${traders.length}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  let page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('Getting Bybit session...');
  try {
    await page.goto('https://www.bybit.com/copyTrading/traderRanking', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
  } catch (e) {
    console.log('  Nav note:', e.message.slice(0, 60));
  }
  await sleep(4000);

  let updated = 0, noData = 0, errors = 0, consecutive = 0;

  for (let i = 0; i < traders.length; i++) {
    const mark = traders[i];
    const rows = traderMap.get(mark) || [];

    if (i > 0 && i % 200 === 0) {
      try {
        await page.goto('https://www.bybit.com/copyTrading/traderRanking', {
          waitUntil: 'domcontentloaded', timeout: 20000
        });
        await sleep(3000);
        consecutive = 0;
      } catch {}
    }

    const apiUrl = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(mark)}`;
    
    try {
      const resp = await page.goto(apiUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      
      if (!resp?.ok()) {
        errors++; consecutive++;
        await sleep(500);
        continue;
      }

      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (!text || text.startsWith('<')) {
        errors++; consecutive++;
        await sleep(500);
        continue;
      }

      const json = JSON.parse(text);
      if (json.retCode !== 0) {
        noData++; consecutive++;
        await sleep(200);
        continue;
      }

      consecutive = 0;
      const result = json.result;
      
      // Get cumulative trade count (best available data)
      const cumTC = parseInt(result.cumTradeCount || '0');
      if (cumTC === 0) { noData++; continue; }
      
      // Update all rows for this trader (all periods get the same cumulative count)
      // Note: we already filtered trades_count=is.null when fetching, so no need to check
      for (const row of rows) {
        await sbPatch(row.id, { trades_count: cumTC });
        updated++;
      }

    } catch (e) {
      errors++; consecutive++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  [${i+1}/${traders.length}] updated=${updated} noData=${noData} errors=${errors}`);
    }
    
    await sleep(120);

    if (consecutive >= 10) {
      console.log(`  Refreshing after ${consecutive} consecutive failures...`);
      try {
        await page.goto('https://www.bybit.com/copyTrading/traderRanking', {
          waitUntil: 'domcontentloaded', timeout: 20000
        });
        await sleep(3000);
        consecutive = 0;
      } catch {}
    }
  }

  await browser.close();

  console.log(`\n✅ Bybit TC Results:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  No data (retCode!=0 or cumTC=0): ${noData}`);
  console.log(`  Errors: ${errors}`);

  const vr = await fetch(`${SB_URL}/rest/v1/leaderboard_ranks?source=eq.bybit&trades_count=is.null&select=id`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
  });
  console.log(`\n📊 Remaining null: ${vr.headers.get('content-range')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
