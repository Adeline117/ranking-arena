/* eslint-disable */
import { chromium } from 'playwright';
import fs from 'fs';

const BASE_URL = 'https://www.arenafi.org';

const PAGES = [
  { name: 'homepage', path: '/' },
  { name: 'rankings', path: '/rankings' },
  { name: 'rankings-binance', path: '/rankings/binance_futures' },
  { name: 'rankings-hyperliquid', path: '/rankings/hyperliquid' },
  { name: 'rankings-bybit', path: '/rankings/bybit' },
  { name: 'rankings-dydx', path: '/rankings/dydx' },
  { name: 'market', path: '/market' },
  { name: 'groups', path: '/groups' },
  { name: 'learn', path: '/learn' },
  { name: 'login', path: '/login' },
  { name: 'pricing', path: '/pricing' },
  { name: 'search', path: '/search' },
  { name: 'compare', path: '/compare' },
  { name: 'about', path: '/about' },
  { name: 'privacy', path: '/privacy' },
  { name: 'terms', path: '/terms' },
  { name: 'hot', path: '/hot' },
  { name: 'settings', path: '/settings' },
];

const TRADER_PAGES = [
  { name: 'trader-binance', path: null, platform: 'binance_futures' },
  { name: 'trader-hyperliquid', path: null, platform: 'hyperliquid' },
  { name: 'trader-bybit', path: null, platform: 'bybit' },
];

const results = [];

async function testPage(page, name, url) {
  const consoleErrors = [];
  const failedRequests = [];

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().substring(0, 200));
  });

  page.on('requestfailed', req => {
    failedRequests.push(`${req.url().substring(0, 100)} — ${req.failure()?.errorText || 'unknown'}`);
  });

  page.on('response', resp => {
    if (resp.status() >= 400 && !resp.url().includes('favicon')) {
      failedRequests.push(`HTTP ${resp.status()} ${resp.url().substring(0, 120)}`);
    }
  });

  let httpStatus = 0;
  let bodyLength = 0;
  let notes = [];
  let extraChecks = {};

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    httpStatus = response?.status() || 0;

    // Wait a bit for JS to render
    await page.waitForTimeout(3000);

    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    bodyLength = bodyText.length;

    // Page-specific checks
    if (name === 'homepage') {
      // Check for welcome modal
      const modalVisible = await page.locator('[role="dialog"], .modal, [data-testid="welcome-modal"]').isVisible().catch(() => false);
      const welcomeText = bodyText.includes('Welcome') || bodyText.includes('Arena');
      extraChecks.welcomeModal = modalVisible ? 'YES - modal visible' : (welcomeText ? 'text present, no modal' : 'NO');

      // Check market ticker
      const tickerEl = await page.locator('nav').innerText().catch(() => '');
      extraChecks.marketTicker = (tickerEl.includes('$') || tickerEl.includes('BTC')) ? 'YES - prices visible' : 'NOT FOUND';
    }

    if (name.startsWith('rankings')) {
      // Check for trader data in table
      const rows = await page.locator('table tbody tr, [data-testid="trader-row"], .trader-row').count().catch(() => 0);
      const hasNumbers = /\d+\.?\d*%/.test(bodyText);
      extraChecks.traderData = rows > 0 ? `${rows} rows` : (hasNumbers ? 'data visible (no table rows found)' : 'NO DATA');
    }

    if (name === 'groups') {
      const failedToLoad = bodyText.includes('Failed to Load') || bodyText.includes('failed to load');
      const hasPosts = bodyText.includes('post') || bodyText.includes('Post') || bodyText.includes('group') || bodyText.includes('Group');
      extraChecks.groupsStatus = failedToLoad ? 'FAILED TO LOAD ERROR' : (hasPosts ? 'OK - content visible' : 'NO CONTENT');
    }

    // Screenshot
    const screenshotPath = `/tmp/final-${name}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });

    results.push({
      page: name,
      url: url,
      status: httpStatus,
      contentOk: bodyLength > 500,
      bodyLength,
      consoleErrors: consoleErrors.length,
      failedRequests: failedRequests.length,
      consoleErrorList: consoleErrors.slice(0, 3),
      failedRequestList: failedRequests.slice(0, 5),
      extraChecks,
      screenshot: screenshotPath,
      notes: notes.join('; '),
    });

    return { consoleErrors, failedRequests, bodyLength, httpStatus };
  } catch (err) {
    results.push({
      page: name,
      url: url,
      status: httpStatus || 'TIMEOUT/ERROR',
      contentOk: false,
      bodyLength: 0,
      consoleErrors: consoleErrors.length,
      failedRequests: failedRequests.length,
      consoleErrorList: [],
      failedRequestList: [],
      extraChecks,
      screenshot: null,
      notes: `ERROR: ${err.message.substring(0, 100)}`,
    });
    return { consoleErrors: [], failedRequests: [], bodyLength: 0, httpStatus: 0 };
  }
}

async function discoverTraderPages(page) {
  // Visit a rankings page and extract real trader links
  const traderLinks = {};

  for (const tp of TRADER_PAGES) {
    try {
      console.log(`Discovering trader for platform: ${tp.platform}...`);
      await page.goto(`${BASE_URL}/rankings/${tp.platform}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await page.waitForTimeout(3000);

      // Look for trader links
      const links = await page.$$eval('a[href*="/trader/"]', els =>
        els.slice(0, 3).map(el => el.getAttribute('href'))
      );

      if (links.length > 0) {
        traderLinks[tp.platform] = links[0];
        console.log(`  Found trader: ${links[0]}`);
      } else {
        // Try href that contains traderId
        const allLinks = await page.$$eval('a', els =>
          els.map(el => el.getAttribute('href')).filter(h => h && h.includes('trader'))
        );
        if (allLinks.length > 0) {
          traderLinks[tp.platform] = allLinks[0];
          console.log(`  Found trader (fallback): ${allLinks[0]}`);
        } else {
          console.log(`  No trader links found for ${tp.platform}`);
        }
      }
    } catch (err) {
      console.log(`  Error discovering trader for ${tp.platform}: ${err.message}`);
    }
  }

  return traderLinks;
}

async function runBatch(pages, batchNum) {
  console.log(`\n--- Batch ${batchNum}: Testing ${pages.length} pages ---`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  for (const pageConfig of pages) {
    const url = pageConfig.path.startsWith('http') ? pageConfig.path : `${BASE_URL}${pageConfig.path}`;
    console.log(`Testing: ${pageConfig.name} → ${url}`);
    const page = await context.newPage();
    await testPage(page, pageConfig.name, url);
    await page.close();
  }

  await context.close();
  await browser.close();
}

async function main() {
  console.log('=== Arena QA Browser Test ===');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Pages: ${PAGES.length} + trader detail pages`);
  console.log('');

  // Batch 1: homepage, rankings, rankings-binance, rankings-hyperliquid, rankings-bybit
  const batch1 = PAGES.slice(0, 5);
  await runBatch(batch1, 1);

  // Batch 2: rankings-dydx, market, groups, learn, login
  const batch2 = PAGES.slice(5, 10);
  await runBatch(batch2, 2);

  // Batch 3: pricing, search, compare, about, privacy
  const batch3 = PAGES.slice(10, 15);
  await runBatch(batch3, 3);

  // Batch 4: terms, hot, settings
  const batch4 = PAGES.slice(15);
  await runBatch(batch4, 4);

  // Batch 5: Discover and test trader detail pages
  console.log('\n--- Batch 5: Trader Detail Pages ---');
  const browser5 = await chromium.launch({ headless: true });
  const context5 = await browser5.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const discoveryPage = await context5.newPage();
  const traderLinks = await discoverTraderPages(discoveryPage);
  await discoveryPage.close();

  for (const tp of TRADER_PAGES) {
    const traderPath = traderLinks[tp.platform];
    if (traderPath) {
      const url = traderPath.startsWith('http') ? traderPath : `${BASE_URL}${traderPath}`;
      console.log(`Testing trader: ${tp.name} → ${url}`);
      const page = await context5.newPage();
      await testPage(page, tp.name, url);
      await page.close();
    } else {
      results.push({
        page: tp.name,
        url: `${BASE_URL}/rankings/${tp.platform}`,
        status: 'N/A',
        contentOk: false,
        bodyLength: 0,
        consoleErrors: 0,
        failedRequests: 0,
        consoleErrorList: [],
        failedRequestList: [],
        extraChecks: {},
        screenshot: null,
        notes: 'Could not discover trader URL from rankings page',
      });
    }
  }

  await context5.close();
  await browser5.close();

  // Print results
  console.log('\n\n=== RESULTS SUMMARY ===\n');

  // Table header
  console.log('| Page | Status | Content? | Console Errors | Failed Requests | Notes |');
  console.log('|------|--------|----------|----------------|-----------------|-------|');

  for (const r of results) {
    const contentMark = r.contentOk ? 'YES' : 'NO';
    const notes = r.notes || '';
    const extras = Object.entries(r.extraChecks || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
    const allNotes = [notes, extras].filter(Boolean).join(' | ');
    console.log(`| ${r.page} | ${r.status} | ${contentMark} (${r.bodyLength}) | ${r.consoleErrors} | ${r.failedRequests} | ${allNotes} |`);
  }

  // Detailed issues
  console.log('\n\n=== DETAILED ISSUES ===\n');
  for (const r of results) {
    const hasIssues = r.consoleErrors > 0 || r.failedRequests > 0 || !r.contentOk;
    if (hasIssues) {
      console.log(`\n### ${r.page} (${r.url})`);
      if (!r.contentOk) console.log(`  - LOW CONTENT: only ${r.bodyLength} chars`);
      if (r.consoleErrorList.length > 0) {
        console.log(`  - Console errors (${r.consoleErrors} total):`);
        r.consoleErrorList.forEach(e => console.log(`    * ${e}`));
      }
      if (r.failedRequestList.length > 0) {
        console.log(`  - Failed requests (${r.failedRequests} total):`);
        r.failedRequestList.forEach(e => console.log(`    * ${e}`));
      }
    }
  }

  // Special checks summary
  console.log('\n\n=== SPECIAL CHECKS ===\n');
  const homeResult = results.find(r => r.page === 'homepage');
  if (homeResult) {
    console.log(`Welcome Modal: ${homeResult.extraChecks?.welcomeModal || 'not checked'}`);
    console.log(`Market Ticker: ${homeResult.extraChecks?.marketTicker || 'not checked'}`);
  }
  const rankingsResult = results.find(r => r.page === 'rankings');
  if (rankingsResult) {
    console.log(`Rankings Table Data: ${rankingsResult.extraChecks?.traderData || 'not checked'}`);
  }
  const groupsResult = results.find(r => r.page === 'groups');
  if (groupsResult) {
    console.log(`Groups Page Status: ${groupsResult.extraChecks?.groupsStatus || 'not checked'}`);
  }

  console.log('\n=== Screenshots saved to /tmp/final-*.png ===');

  // Save JSON results
  fs.writeFileSync('/tmp/arena-qa-results.json', JSON.stringify(results, null, 2));
  console.log('Full results saved to /tmp/arena-qa-results.json');
}

main().catch(console.error);
