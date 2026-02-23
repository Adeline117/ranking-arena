import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
  
  await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  
  await page.goto('https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=1&pageSize=3&dataDuration=DATA_DURATION_SEVEN_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI', { waitUntil: 'domcontentloaded', timeout: 12000 });
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const j = JSON.parse(text);
  console.log('retCode:', j.retCode);
  const items = j.result?.leaderDetails || [];
  for (const item of items) {
    console.log('leaderUserId:', item.leaderUserId, 'leaderMark:', item.leaderMark?.slice(0,20), 'type:', typeof item.leaderMark);
  }
  await browser.close();
})().catch(console.error);
