import { chromium } from 'playwright';

const BASE = 'https://www.arenafi.org';
const PAGES = [
  ['/', 'Homepage'],
  ['/rankings', 'Rankings'],
  ['/rankings/binance_futures', 'Binance Futures'],
  ['/rankings/hyperliquid', 'Hyperliquid'],
  ['/market', 'Market'],
  ['/search', 'Search'],
  ['/pricing', 'Pricing'],
];

const browser = await chromium.launch({ headless: true });

console.log('=== Core Web Vitals Audit ===\n');

for (const [path, name] of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const start = Date.now();
  try {
    await page.goto(`${BASE}${path}`, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);

    const metrics = await page.evaluate(() => {
      const entries = performance.getEntries();

      // LCP
      const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      const lcp = lcpEntries.length > 0 ? lcpEntries[lcpEntries.length - 1].startTime : null;

      // CLS
      let cls = 0;
      const layoutShifts = performance.getEntriesByType('layout-shift');
      layoutShifts.forEach(entry => {
        if (!entry.hadRecentInput) cls += entry.value;
      });

      // FCP
      const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0];
      const fcp = fcpEntry ? fcpEntry.startTime : null;

      // TBT approximation (long tasks > 50ms)
      let tbt = 0;
      const longTasks = performance.getEntriesByType('longtask');
      longTasks.forEach(task => { tbt += Math.max(0, task.duration - 50); });

      // Resource stats
      const resources = performance.getEntriesByType('resource');
      const jsFiles = resources.filter(r => r.name.includes('.js'));
      const cssFiles = resources.filter(r => r.name.includes('.css'));
      const fonts = resources.filter(r => r.name.includes('.woff') || r.name.includes('.ttf'));
      const totalTransfer = resources.reduce((s, r) => s + (r.transferSize || 0), 0);

      // Check for FOUT (font display swap causing text re-render)
      const fontFaces = Array.from(document.fonts).map(f => ({
        family: f.family,
        display: f.display,
        status: f.status,
      }));

      return {
        lcp: lcp ? Math.round(lcp) : null,
        cls: Math.round(cls * 1000) / 1000,
        fcp: fcp ? Math.round(fcp) : null,
        tbt: Math.round(tbt),
        jsCount: jsFiles.length,
        cssCount: cssFiles.length,
        fontCount: fonts.length,
        totalRequests: resources.length,
        totalKB: Math.round(totalTransfer / 1024),
        fontFaces: fontFaces.slice(0, 10),
      };
    });

    // Grade each metric
    const lcpGrade = !metrics.lcp ? '?' : metrics.lcp <= 2500 ? '🟢' : metrics.lcp <= 4000 ? '🟡' : '🔴';
    const clsGrade = metrics.cls <= 0.1 ? '🟢' : metrics.cls <= 0.25 ? '🟡' : '🔴';
    const fcpGrade = !metrics.fcp ? '?' : metrics.fcp <= 1800 ? '🟢' : metrics.fcp <= 3000 ? '🟡' : '🔴';

    console.log(`${name}`);
    console.log(`  LCP: ${metrics.lcp || '?'}ms ${lcpGrade}  CLS: ${metrics.cls} ${clsGrade}  FCP: ${metrics.fcp || '?'}ms ${fcpGrade}  TBT: ${metrics.tbt}ms`);
    console.log(`  Resources: ${metrics.totalRequests} (${metrics.jsCount} JS, ${metrics.cssCount} CSS, ${metrics.fontCount} fonts, ${metrics.totalKB}KB)`);

    // Check for FOUT
    const swapFonts = metrics.fontFaces.filter(f => f.display === 'swap');
    if (swapFonts.length > 0) {
      console.log(`  ⚠️ FOUT risk: ${swapFonts.length} fonts with display:swap — ${swapFonts.map(f => f.family).join(', ')}`);
    }

    console.log('');
  } catch (e) {
    console.log(`${name}: ERROR — ${e.message?.slice(0, 60)}\n`);
  }

  await page.close();
}

// CSS analysis
console.log('=== CSS File Analysis ===\n');
const cssPage = await browser.newPage();
await cssPage.goto(BASE, { timeout: 30000, waitUntil: 'load' });
await cssPage.waitForTimeout(5000);

const cssInfo = await cssPage.evaluate(() => {
  const sheets = Array.from(document.styleSheets);
  const results = [];
  for (const sheet of sheets) {
    try {
      const rules = sheet.cssRules?.length || 0;
      const href = sheet.href || 'inline';
      results.push({ href: href.split('/').pop()?.slice(0, 50) || href, rules });
    } catch { /* cross-origin */ }
  }

  // Check total CSS size via link elements
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  const linkHrefs = links.map(l => l.href?.split('/').pop()?.slice(0, 50));

  // Check inline styles total
  const inlineStyles = document.querySelectorAll('style');
  let inlineTotal = 0;
  inlineStyles.forEach(s => { inlineTotal += s.textContent?.length || 0; });

  return { sheets: results, linkCount: links.length, linkHrefs, inlineStyleCount: inlineStyles.length, inlineKB: Math.round(inlineTotal / 1024) };
});

console.log(`Stylesheets: ${cssInfo.sheets.length}`);
cssInfo.sheets.forEach(s => console.log(`  ${s.rules} rules — ${s.href}`));
console.log(`External CSS files: ${cssInfo.linkCount}`);
console.log(`Inline <style> tags: ${cssInfo.inlineStyleCount} (${cssInfo.inlineKB}KB)`);

await browser.close();
