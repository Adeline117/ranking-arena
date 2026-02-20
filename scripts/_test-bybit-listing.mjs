import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  
  console.log('Visiting bybit.com/copyTrade...');
  try {
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);
    console.log('Page URL:', page.url());
  } catch(e) { console.log('goto err:', e.message?.slice(0,80)); }
  
  // Test via page.evaluate fetch
  const r1 = await page.evaluate(async () => {
    try {
      const r = await fetch('https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=1&pageSize=3&dataDuration=DATA_DURATION_SEVEN_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI');
      const j = await r.json();
      return { 
        code: j.retCode, 
        msg: j.retMsg, 
        len: j.result?.leaderDetails?.length,
        first_uid: j.result?.leaderDetails?.[0]?.leaderUserId,
        first_mark: (j.result?.leaderDetails?.[0]?.leaderMark || '').slice(0,10)
      };
    } catch(e) { return { error: e.message }; }
  });
  console.log('Evaluate fetch result:', JSON.stringify(r1));
  
  // Also try navigating to the API URL directly
  console.log('\nTrying page.goto to API...');
  try {
    await page.goto('https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=1&pageSize=3&dataDuration=DATA_DURATION_SEVEN_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI', { waitUntil: 'domcontentloaded', timeout: 12000 });
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    try {
      const j = JSON.parse(text);
      console.log('Nav result retCode:', j.retCode, 'len:', j.result?.leaderDetails?.length, 'first_uid:', j.result?.leaderDetails?.[0]?.leaderUserId);
    } catch { console.log('Nav text (first 150):', text.slice(0,150)); }
  } catch(e) { console.log('Nav err:', e.message?.slice(0,80)); }
  
  await browser.close();
  console.log('Done');
})().catch(console.error);
