import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({headless:'new',args:['--no-sandbox']});
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

  let captured = null;
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('/v1/traders/v2') && !captured) {
      try {
        const d = await resp.json();
        captured = d;
      } catch {}
    }
  });

  await page.goto('https://www.mexc.com/futures/copyTrade/home', {waitUntil:'networkidle2',timeout:60000}).catch(()=>{});
  await sleep(5000);
  
  if (!captured) {
    // Try clicking All Traders
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.textContent||'').trim() === 'All Traders') { try { el.click(); } catch {} return; }
      }
    }).catch(()=>{});
    await sleep(3000);
  }

  if (captured?.data?.content) {
    const item = captured.data.content[0];
    console.log('Fields:', Object.keys(item).join(', '));
    console.log('Avatar fields:', ['avatar','avatarUrl','headImg','photoUrl','userPhoto','imgUrl','portrait','icon'].filter(k => k in item));
    console.log('Sample avatar:', item.avatar || item.avatarUrl || item.headImg || item.photoUrl || 'NONE');
    console.log('Sample uid:', item.uid || item.userId);
    console.log('Sample nickname:', item.nickname || item.nickName);
  } else {
    // Try direct API
    const result = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/v1/futures/copy_trade/v1/traders/v2?page=1&pageSize=3&period=30&sortField=roi');
        return r.json();
      } catch (e) { return {error: e.message}; }
    });
    console.log('Direct API result:', JSON.stringify(result?.data?.content?.[0] || result, null, 2).slice(0, 500));
  }

  await browser.close();
})().catch(console.error);
