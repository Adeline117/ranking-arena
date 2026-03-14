import { chromium } from 'playwright';

const urls = [
  'https://www.arenafi.org/',
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  
  for (const url of urls) {
    console.log(`\n📸 ${url}`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      const filename = url.replace(/https?:\/\//, '').replace(/\//g, '_') || 'home';
      await page.screenshot({ 
        path: `/tmp/arena-screenshots/${filename}.png`,
        fullPage: false
      });
      console.log(`✓ ${filename}.png`);
    } catch (err) {
      console.error(`❌ ${url}: ${err.message}`);
    }
  }
  
  await browser.close();
})();
