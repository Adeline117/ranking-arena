#!/usr/bin/env node
import { chromium } from 'playwright';

const apis = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on('response', async (response) => {
  const url = response.url();
  if (url.includes('/api/') && !url.includes('.js') && !url.includes('.css')) {
    const contentType = response.headers()['content-type'] || '';
    if (contentType.includes('json') && response.status() === 200) {
      const priority = (url.includes('lead') || url.includes('trade') || url.includes('copy') || url.includes('rank')) ? '⭐' : '';
      apis.push({ priority, method: response.request().method(), url, status: response.status() });
    }
  }
});

console.log('Loading OKX...');
await page.goto('https://www.okx.com/copy-trading/leaderboard', { timeout: 45000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
await page.evaluate(() => window.scrollTo(0, 500));
await page.waitForTimeout(3000);

console.log('\n=== Copy Trading APIs ===');
const priorityAPIs = apis.filter(a => a.priority);
const otherAPIs = apis.filter(a => !a.priority);

priorityAPIs.forEach((a, i) => console.log(`${i+1}. ${a.priority} [${a.status}] ${a.method} ${a.url}`));
console.log(`\nOther: ${otherAPIs.length} non-priority APIs`);

await browser.close();
console.log(`\n✅ Done - found ${apis.length} APIs (${priorityAPIs.length} priority)`);
