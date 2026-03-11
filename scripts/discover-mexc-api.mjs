#!/usr/bin/env node
/**
 * Discover MEXC Copy Trading API Endpoints
 */

import { chromium } from 'playwright';

async function discoverMexcAPI() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const apiCalls = [];
  
  page.on('response', async (response) => {
    const url = response.url();
    // Capture all API calls, especially copy-trade related
    if (url.includes('/api/') && !url.includes('.js') && !url.includes('.css') && 
        !url.includes('.png') && !url.includes('.woff') && !url.includes('sentry')) {
      try {
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('json') || url.includes('copy')) {
          const priority = url.includes('copy') || url.includes('trader') || url.includes('lead') ? '⭐' : '';
          apiCalls.push({
            url,
            status: response.status(),
            method: response.request().method(),
            priority,
          });
        }
      } catch (e) {}
    }
  });

  console.log('Loading MEXC copy trading page...');
  await page.goto('https://www.mexc.com/copy-trading', { 
    timeout: 45000, 
    waitUntil: 'domcontentloaded' 
  });
  
  console.log('Waiting for initial render...');
  await page.waitForTimeout(5000);
  
  console.log('Scrolling to trigger lazy loading...');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);
  
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(3000);

  console.log('\n=== API Calls Captured ===');
  const uniqueAPIs = [...new Set(apiCalls.map(a => a.url))];
  uniqueAPIs.forEach((url, i) => {
    const call = apiCalls.find(a => a.url === url);
    console.log(`${i + 1}. [${call.status}] ${call.method} ${url}`);
  });

  await browser.close();
  
  if (uniqueAPIs.length === 0) {
    console.log('\n⚠️ No API calls found. MEXC might be using a different method.');
  } else {
    console.log(`\n✅ Found ${uniqueAPIs.length} unique API endpoints`);
  }
}

discoverMexcAPI().catch(console.error);
