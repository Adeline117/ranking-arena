import { chromium } from 'playwright';

const pages = [
  { name: 'home', url: 'https://www.arenafi.org', wait: 8000 },
  { name: 'trader', url: 'https://www.arenafi.org/trader/4906010685108267264', wait: 6000 },
  { name: 'library', url: 'https://www.arenafi.org/library', wait: 5000 },
  { name: 'groups', url: 'https://www.arenafi.org/groups', wait: 5000 },
  { name: 'post', url: 'https://www.arenafi.org/post', wait: 5000 },
];

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844, isMobile: true },
];

const browser = await chromium.launch({ headless: true });

for (const page of pages) {
  for (const vp of viewports) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.isMobile || false,
      deviceScaleFactor: vp.isMobile ? 3 : 2,
      colorScheme: 'dark',
    });
    const p = await ctx.newPage();
    try {
      await p.goto(page.url, { waitUntil: 'networkidle', timeout: 30000 });
      await p.waitForTimeout(page.wait);
      await p.screenshot({ 
        path: `/tmp/arena-screenshots/${page.name}-${vp.name}.png`,
        fullPage: false,
      });
      console.log(`✓ ${page.name}-${vp.name}`);
    } catch(e) {
      console.log(`✗ ${page.name}-${vp.name}: ${e.message}`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log('Done');
