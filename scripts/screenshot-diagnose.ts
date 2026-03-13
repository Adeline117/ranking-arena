import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'fs';

const PAGES = [
  { name: '01-home', url: 'https://www.arenafi.org/' },
  { name: '02-rankings-all', url: 'https://www.arenafi.org/rankings' },
  { name: '03-rankings-binance', url: 'https://www.arenafi.org/rankings/binance_futures' },
  { name: '04-rankings-hl', url: 'https://www.arenafi.org/rankings/hyperliquid' },
  { name: '05-trader-hl', url: 'https://www.arenafi.org/trader/0x598f9efb3164ec216b4eff33c2b239605be5af8e?platform=hyperliquid' },
  { name: '06-search', url: 'https://www.arenafi.org/search?q=trader' },
  { name: '07-compare', url: 'https://www.arenafi.org/compare' },
  { name: '08-market', url: 'https://www.arenafi.org/market' },
  { name: '09-flash-news', url: 'https://www.arenafi.org/flash-news' },
  { name: '10-library', url: 'https://www.arenafi.org/rankings/resources' },
  { name: '11-institutions', url: 'https://www.arenafi.org/rankings/institutions' },
  { name: '12-pricing', url: 'https://www.arenafi.org/pricing' },
  { name: '13-settings', url: 'https://www.arenafi.org/settings' },
];

const OUTPUT_DIR = 'scripts/screenshots/diag';

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch();

  for (const pg of PAGES) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 800 } });
    const page = await context.newPage();

    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 200)); });
    page.on('requestfailed', req => errors.push(`FAIL: ${req.url().slice(0, 150)}`));

    try {
      await page.goto(pg.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Desktop: top
      const buf1 = await page.screenshot({ clip: { x: 0, y: 0, width: 1400, height: 800 } });
      await sharp(buf1).resize(1400, 800, { fit: 'inside' }).toFile(`${OUTPUT_DIR}/${pg.name}_top.png`);

      // Desktop: scroll to middle
      const pageHeight = await page.evaluate(() => document.body.scrollHeight);
      if (pageHeight > 900) {
        await page.evaluate(() => window.scrollTo(0, 800));
        await page.waitForTimeout(500);
        const buf2 = await page.screenshot({ clip: { x: 0, y: 0, width: 1400, height: 800 } });
        await sharp(buf2).resize(1400, 800, { fit: 'inside' }).toFile(`${OUTPUT_DIR}/${pg.name}_mid.png`);
      }

      // Desktop: scroll to bottom
      if (pageHeight > 1700) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
        const buf3 = await page.screenshot({ clip: { x: 0, y: 0, width: 1400, height: 800 } });
        await sharp(buf3).resize(1400, 800, { fit: 'inside' }).toFile(`${OUTPUT_DIR}/${pg.name}_bot.png`);
      }

      // Mobile
      await page.setViewportSize({ width: 375, height: 812 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1500);
      const bufM = await page.screenshot({ clip: { x: 0, y: 0, width: 375, height: 812 } });
      await sharp(bufM).resize(375, 812, { fit: 'inside' }).toFile(`${OUTPUT_DIR}/${pg.name}_mobile.png`);

      console.log(`✅ ${pg.name}: ${errors.length} errors`);
      if (errors.length > 0) console.log(`   ${errors.slice(0, 3).join('\n   ')}`);
    } catch (e: any) {
      console.log(`❌ ${pg.name}: ${e.message}`);
    }

    await context.close();
  }

  await browser.close();
  console.log(`\nDone. Screenshots in ${OUTPUT_DIR}/`);
}

run();
