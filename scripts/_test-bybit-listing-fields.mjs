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

  // Get listing with 7D duration
  const url = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=1&pageSize=3&dataDuration=DATA_DURATION_SEVEN_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI';
  const resp = await page.goto(url, {waitUntil:'domcontentloaded',timeout:10000});
  const text = await page.evaluate(()=>document.body?.innerText||'').catch(()=>'');
  
  if (!text.startsWith('<')) {
    const j = JSON.parse(text);
    const item = j.result?.leaderDetails?.[0];
    if (item) {
      console.log('All keys:', Object.keys(item).join(', '));
      const tcKeys = ['winCount','loseCount','tradeCount','tradesCount','orderCount'].filter(k => k in item);
      console.log('TC-related keys:', tcKeys);
      tcKeys.forEach(k => console.log('  '+k+':', item[k]));
      const wrKeys = ['winRate','profitWinRate','sevenDayWinRate'].filter(k => k in item);
      console.log('WR-related keys:', wrKeys);
    }
  }
  
  // Also check leader-income full response
  const mark = j?.result?.leaderDetails?.[0]?.leaderMark;
  if (mark) {
    const incomeUrl = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark='+encodeURIComponent(mark);
    const resp2 = await page.goto(incomeUrl,{waitUntil:'domcontentloaded',timeout:10000});
    const text2 = await page.evaluate(()=>document.body?.innerText||'').catch(()=>'');
    if (!text2.startsWith('<')) {
      const j2 = JSON.parse(text2);
      if (j2.retCode === 0) {
        const r = j2.result;
        console.log('\nleader-income result keys:', Object.keys(r).join(', '));
        const periodKeys = Object.keys(r).filter(k => k.startsWith('seven') || k.startsWith('thirty') || k.startsWith('ninety'));
        console.log('Period-specific keys:', periodKeys);
        periodKeys.forEach(k => console.log('  '+k+':', r[k]));
      }
    }
  }
  
  await browser.close();
})().catch(console.error);
