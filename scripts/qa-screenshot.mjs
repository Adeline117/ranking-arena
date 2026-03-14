#!/usr/bin/env node
/**
 * QA Auto-Screenshot Script
 * Captures 21 pages × 2 viewports × 2 views = 84 screenshots
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:3000';
const ROUND_DIR = process.argv[2] || 'round-001';
const SCREENSHOT_DIR = path.join(process.cwd(), 'scripts/screenshots', ROUND_DIR);

// 21 pages to capture
const PAGES = [
  { path: '/', name: 'home' },
  { path: '/rankings', name: 'rankings-all' },
  { path: '/rankings/binance_futures', name: 'ranking-binance' },
  { path: '/rankings/okx_futures', name: 'ranking-okx' },
  { path: '/rankings/hyperliquid', name: 'ranking-hyperliquid' },
  { path: '/rankings/bybit', name: 'ranking-bybit' },
  { path: '/trader/test123', name: 'trader-detail' },
  { path: '/rankings/resources', name: 'resources' },
  { path: '/rankings/institutions', name: 'institutions' },
  { path: '/rankings/tools', name: 'tools' },
  { path: '/flash-news', name: 'flash-news' },
  { path: '/market', name: 'market' },
  { path: '/pricing', name: 'pricing' },
  { path: '/settings', name: 'settings' },
  { path: '/about', name: 'about' },
  { path: '/methodology', name: 'methodology' },
  { path: '/404-test-page', name: '404' }
];

const VIEWPORTS = [
  { name: 'desktop', width: 1400, height: 800 },
  { name: 'mobile', width: 375, height: 800 }
];

// Create directory
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Error logs
const consoleErrors = [];
const pageErrors = [];

async function captureScreenshot(page, url, name, viewport, view) {
  const filename = `${name}-${viewport}-${view}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    
    // Capture initial view
    if (view === 'top') {
      await page.screenshot({ path: filepath, fullPage: false });
    } else {
      // Scroll down
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await page.waitForTimeout(500);
      await page.screenshot({ path: filepath, fullPage: false });
    }
    
    console.log(`✓ ${filename}`);
  } catch (error) {
    console.error(`✗ ${filename}: ${error.message}`);
    pageErrors.push({ page: name, viewport, view, error: error.message });
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  
  // Capture console errors
  context.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), location: msg.location() });
    }
  });
  
  // Capture page errors
  context.on('pageerror', error => {
    pageErrors.push({ error: error.message });
  });
  
  const page = await context.newPage();
  
  let count = 0;
  const total = PAGES.length * VIEWPORTS.length * 2;
  
  for (const pageDef of PAGES) {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      
      const url = `${BASE_URL}${pageDef.path}`;
      
      // Capture top view
      await captureScreenshot(page, url, pageDef.name, viewport.name, 'top');
      count++;
      console.log(`Progress: ${count}/${total}`);
      
      // Capture scrolled view
      await captureScreenshot(page, url, pageDef.name, viewport.name, 'scrolled');
      count++;
      console.log(`Progress: ${count}/${total}`);
    }
  }
  
  await browser.close();
  
  // Write error logs
  if (consoleErrors.length > 0) {
    fs.writeFileSync(
      path.join(SCREENSHOT_DIR, 'console-errors.log'),
      JSON.stringify(consoleErrors, null, 2)
    );
    console.log(`\n⚠️ ${consoleErrors.length} console errors logged`);
  }
  
  if (pageErrors.length > 0) {
    fs.writeFileSync(
      path.join(SCREENSHOT_DIR, 'page-errors.log'),
      JSON.stringify(pageErrors, null, 2)
    );
    console.log(`⚠️ ${pageErrors.length} page errors logged`);
  }
  
  console.log(`\n✅ Screenshot round complete: ${count} screenshots in ${SCREENSHOT_DIR}`);
}

main().catch(console.error);
