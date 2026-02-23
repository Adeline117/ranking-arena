import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({headless:'new',args:['--no-sandbox']});
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
  await page.goto('https://www.bybit.com/copyTrading/traderRanking',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  await sleep(3000);
  const mark = 'c27KmeB/I0NV5DoyiTTsog==';
  const url = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark='+encodeURIComponent(mark);
  console.log('URL:', url);
  const resp = await page.goto(url,{waitUntil:'domcontentloaded',timeout:10000}).catch(e=>{console.log('goto err:',e.message);return null;});
  const text = await page.evaluate(()=>document.body?.innerText||'').catch(()=>'');
  console.log('Status:', resp?.status());
  console.log('Text (first 300):', text.slice(0,300));
  await browser.close();
})().catch(console.error);
