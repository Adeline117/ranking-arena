#!/usr/bin/env node
/**
 * Bybit Spot enrichment - navigate directly to API URLs through SOCKS proxy
 * Simpler approach: visit each API URL directly as navigation
 */
import 'dotenv/config';
import pg from 'pg';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchViaNav(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (!resp || !resp.ok()) return null;
    const text = await page.evaluate(() => document.body?.innerText || '');
    return JSON.parse(text);
  } catch { return null; }
}

async function main() {
  console.log('=== Bybit Spot enrichment (nav approach + SOCKS proxy) ===');
  const client = await pool.connect();

  const { rows: needed } = await client.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source = 'bybit_spot' 
      AND (trades_count IS NULL OR max_drawdown IS NULL)
  `);
  const needSet = new Set(needed.map(r => r.source_trader_id));
  console.log(`Traders needing enrichment: ${needSet.size}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--proxy-server=socks5://127.0.0.1:1080']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  // Visit bybit first to establish cookies
  console.log('Getting cookies from bybit.com...');
  try {
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);
    console.log('Page loaded, now testing API...');
  } catch (e) {
    console.log('Warning:', e.message?.slice(0, 100));
  }

  // Test API access
  const testResult = await fetchViaNav(page, 
    'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=1&pageSize=2&dataDuration=DATA_DURATION_NINETY_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI'
  );
  console.log('API test:', testResult ? `retCode=${testResult.retCode}, items=${testResult.result?.leaderDetails?.length}` : 'FAILED');
  
  if (!testResult || testResult.retCode !== 0) {
    console.log('API not accessible, aborting');
    await browser.close();
    client.release();
    await pool.end();
    return;
  }

  const uidToMark = new Map();
  let updated = 0;

  // Paginate listing
  for (const duration of ['DATA_DURATION_NINETY_DAY', 'DATA_DURATION_THIRTY_DAY', 'DATA_DURATION_SEVEN_DAY']) {
    console.log(`\n📡 Listing ${duration}...`);
    for (let pageNo = 1; pageNo <= 100; pageNo++) {
      const result = await fetchViaNav(page,
        `https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=50&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`
      );

      if (!result || result.retCode !== 0) {
        console.log(`  Page ${pageNo}: error`);
        break;
      }

      const items = result.result?.leaderDetails || [];
      if (!items.length) { console.log(`  Page ${pageNo}: empty`); break; }

      let pageMatches = 0;
      for (const item of items) {
        const uid = String(item.leaderUserId || '');
        if (needSet.has(uid) && item.leaderMark) {
          uidToMark.set(uid, item.leaderMark);
          pageMatches++;
        }
      }

      if (pageNo % 10 === 0 || pageMatches > 0)
        console.log(`  Page ${pageNo}: ${items.length} items, matches=${pageMatches}, total=${uidToMark.size}`);
      await sleep(300);
    }
  }

  console.log(`\nMapped ${uidToMark.size} traders. Fetching income...`);

  const entries = [...uidToMark.entries()];
  for (let i = 0; i < entries.length; i++) {
    const [uid, mark] = entries[i];

    const incomeData = await fetchViaNav(page,
      `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${mark}`
    );

    if (!incomeData || incomeData.retCode !== 0) { await sleep(200); continue; }

    const inc = incomeData.result;
    let tc = null, mdd = null;
    for (const pfx of ['ninetyDay', 'thirtyDay', 'sevenDay']) {
      const wc = parseInt(inc[pfx + 'WinCount'] || '0');
      const lc = parseInt(inc[pfx + 'LossCount'] || '0');
      if (wc + lc > 0 && tc == null) tc = wc + lc;
      const dd = parseInt(inc[pfx + 'DrawDownE4'] || '0');
      if (dd > 0 && mdd == null) mdd = dd / 100;
    }
    if (tc == null) {
      const cum = parseInt(inc.cumTradeCount || '0');
      if (cum > 0) tc = cum;
    }

    if (tc == null && mdd == null) { await sleep(200); continue; }

    const sets = [];
    const vals = [];
    let idx = 1;
    if (tc != null) { sets.push(`trades_count = $${idx}`); vals.push(tc); idx++; }
    if (mdd != null) { sets.push(`max_drawdown = $${idx}`); vals.push(mdd); idx++; }
    vals.push(uid);

    const r1 = await client.query(
      `UPDATE trader_snapshots SET ${sets.join(', ')} WHERE source='bybit_spot' AND source_trader_id=$${idx} AND (trades_count IS NULL OR max_drawdown IS NULL)`,
      vals
    );
    const r2 = await client.query(
      `UPDATE leaderboard_ranks SET ${sets.join(', ')} WHERE source='bybit_spot' AND source_trader_id=$${idx} AND (trades_count IS NULL OR max_drawdown IS NULL)`,
      vals
    );
    updated += r1.rowCount + r2.rowCount;

    if ((i + 1) % 50 === 0) console.log(`  Income ${i+1}/${entries.length} | updated=${updated}`);
    await sleep(300);
  }

  await browser.close();

  const verify = await client.query(`
    SELECT COUNT(*) FILTER (WHERE trades_count IS NULL) as tc_null, COUNT(*) FILTER (WHERE max_drawdown IS NULL) as mdd_null, COUNT(*) as total
    FROM trader_snapshots WHERE source = 'bybit_spot'
  `);
  console.log('\nDone! Updated:', updated);
  console.log('Remaining:', verify.rows[0]);

  client.release();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
