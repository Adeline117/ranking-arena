import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  
  console.log('Visiting bybit.com/copyTrading/traderRanking...');
  try {
    const resp = await page.goto('https://www.bybit.com/copyTrading/traderRanking', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('  Status:', resp?.status(), 'URL:', page.url());
  } catch(e) { console.log('  err:', e.message?.slice(0,80)); }
  await sleep(3000);
  
  const listURL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=1&pageSize=3&dataDuration=DATA_DURATION_NINETY_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI';
  
  console.log('\nNavigating to listing API...');
  try {
    const resp = await page.goto(listURL, { waitUntil: 'domcontentloaded', timeout: 12000 });
    console.log('  Status:', resp?.status(), 'ok:', resp?.ok());
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    console.log('  Text (first 300):', text.slice(0,300));
    if (text && !text.startsWith('<')) {
      try {
        const j = JSON.parse(text);
        console.log('  retCode:', j.retCode, 'len:', j.result?.leaderDetails?.length, 'first_uid:', j.result?.leaderDetails?.[0]?.leaderUserId);
      } catch(e) { console.log('  Parse error:', e.message); }
    }
  } catch(e) { console.log('  nav error:', e.message?.slice(0,150)); }
  
  await browser.close();
})().catch(console.error);
