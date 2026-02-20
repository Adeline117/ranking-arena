// Deep intercept of Aevo copy-trading page
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
});

const page = await browser.newPage();

// Set realistic browser headers
await page.setExtraHTTPHeaders({
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'application/json, text/plain, */*',
});

const apiResponses = [];

page.on('response', async (response) => {
  const url = response.url();
  if (url.includes('api.aevo.xyz')) {
    try {
      const status = response.status();
      const text = await response.text();
      apiResponses.push({ url, status, body: text.substring(0, 2000) });
    } catch(e) {}
  }
});

console.log('Navigating to copy-trading page...');
try {
  await page.goto('https://app.aevo.xyz/copy-trading', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
} catch (e) {
  console.log('Navigation note:', e.message);
}

// Wait for copy-trading content to load
await new Promise(r => setTimeout(r, 8000));

// Try scrolling to trigger lazy loads
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await new Promise(r => setTimeout(r, 3000));
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise(r => setTimeout(r, 3000));

console.log('\n=== API RESPONSES ===');
for (const r of apiResponses) {
  console.log(`\n[${r.status}] ${r.url}`);
  // Check if it has interesting fields
  const interesting = ['win_rate', 'max_drawdown', 'strategy', 'trader', 'copy', 'profit_factor', 'drawdown', 'master'];
  const hasInteresting = interesting.some(kw => r.body.toLowerCase().includes(kw));
  if (hasInteresting) {
    console.log('*** INTERESTING! ***');
    console.log(r.body.substring(0, 1000));
  } else {
    console.log('(regular):', r.url);
  }
}

// Also check the page source for any embedded data
const pageContent = await page.content();
if (pageContent.includes('win_rate') || pageContent.includes('max_drawdown')) {
  console.log('\n*** win_rate/max_drawdown found in page source! ***');
}

await browser.close();
process.exit(0);
