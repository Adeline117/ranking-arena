// Intercept network requests from Aevo portfolio page for a specific user
import puppeteer from 'puppeteer';

const TRADER_ID = 'pushy-mud-cronje';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

const page = await browser.newPage();

await page.setExtraHTTPHeaders({
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
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

console.log(`Navigating to portfolio page for ${TRADER_ID}...`);
try {
  await page.goto(`https://app.aevo.xyz/portfolio/${TRADER_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
} catch (e) {
  console.log('Navigation note:', e.message);
}

// Wait for data to load
await new Promise(r => setTimeout(r, 10000));

// Scroll to trigger lazy loads
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await new Promise(r => setTimeout(r, 3000));

console.log('\n=== ALL API RESPONSES ===');
for (const r of apiResponses) {
  console.log(`\n[${r.status}] ${r.url}`);
  const interesting = ['win_rate', 'winRate', 'max_drawdown', 'maxDrawdown', 'win_percent', 'trade_count', 'stats', 'profit'];
  const hasInteresting = interesting.some(kw => r.body.toLowerCase().includes(kw.toLowerCase()));
  if (hasInteresting) {
    console.log('*** INTERESTING ***:', r.body.substring(0, 500));
  }
}

await browser.close();
process.exit(0);
