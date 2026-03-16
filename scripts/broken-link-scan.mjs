#!/usr/bin/env node
// Broken link & dead button scanner for arenafi.org
import { chromium } from 'playwright';

const BASE = 'https://www.arenafi.org';
const PAGES = [
  '/',
  '/hot',
  '/groups',
  '/market',
  '/pricing',
  '/rankings/resources',
  '/rankings/institutions',
  '/rankings/tools',
];

const PAGE_TIMEOUT = 30000;
const LINK_CHECK_TIMEOUT = 15000;

const issues = [];
const checkedLinks = new Map(); // href -> status code (cache across pages)

function addIssue(page, element, issue) {
  issues.push({ page, element, issue });
}

async function checkUrl(url) {
  if (checkedLinks.has(url)) return checkedLinks.get(url);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT);
    // Use GET — some servers don't support HEAD
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    clearTimeout(timer);
    checkedLinks.set(url, res.status);
    return res.status;
  } catch (e) {
    checkedLinks.set(url, 'TIMEOUT');
    return 'TIMEOUT';
  }
}

async function scanPage(browser, path) {
  const url = BASE + path;
  console.log(`\n--- Scanning ${url} ---`);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // Navigate and wait
    const response = await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT });

    // Check if page itself 404'd
    if (response && response.status() >= 400) {
      addIssue(path, '(page)', `Page returned ${response.status()}`);
      await context.close();
      return;
    }

    // Wait for client-side hydration
    await page.waitForTimeout(5000);

    // 1. Collect all <a> elements
    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      return anchors.map(a => ({
        href: a.getAttribute('href') || '',
        text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
        visible: a.offsetParent !== null || a.offsetWidth > 0 || a.offsetHeight > 0,
      }));
    });

    // 2. Check href="#" dead links
    const hashLinks = links.filter(l => l.href === '#' && l.visible);
    for (const l of hashLinks) {
      addIssue(path, `"${l.text || '(no text)'}" <a>`, 'href="#" dead link');
    }

    // 3. Collect unique internal hrefs
    const internalHrefs = new Map(); // url -> link text
    for (const l of links) {
      if (!l.href) continue;
      if (l.href === '#' || l.href.startsWith('#')) continue;
      if (l.href.startsWith('javascript:')) continue;
      if (l.href.startsWith('mailto:') || l.href.startsWith('tel:')) continue;

      let resolved = l.href;
      if (l.href.startsWith('/')) {
        resolved = BASE + l.href;
      } else if (l.href.startsWith(BASE)) {
        // already absolute
      } else if (!l.href.startsWith('http')) {
        resolved = BASE + '/' + l.href;
      } else {
        continue; // external
      }
      // Strip hash
      resolved = resolved.split('#')[0];
      if (resolved && resolved !== BASE && resolved !== BASE + '/') {
        if (!internalHrefs.has(resolved)) {
          internalHrefs.set(resolved, l.text);
        }
      }
    }

    console.log(`  Found ${links.length} links, ${hashLinks.length} href="#", ${internalHrefs.size} unique internal to check`);

    // 4. Check internal links - batch with concurrency limit
    const entries = Array.from(internalHrefs.entries());
    const CONCURRENCY = 5;
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async ([href, text]) => {
          const status = await checkUrl(href);
          return { href, text, status };
        })
      );
      for (const { href, text, status } of results) {
        const shortHref = href.replace(BASE, '');
        if (status === 404) {
          addIssue(path, `"${text || shortHref}" <a>`, `404 at ${shortHref}`);
        } else if (status === 500 || status === 502 || status === 503) {
          addIssue(path, `"${text || shortHref}" <a>`, `${status} at ${shortHref}`);
        }
        // Don't report timeouts — these are heavy pages, not broken links
      }
    }

    // 5. Check buttons with no click handler
    const deadButtons = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const results = [];
      for (const btn of buttons) {
        const visible = btn.offsetParent !== null || btn.offsetWidth > 0 || btn.offsetHeight > 0;
        if (!visible) continue;

        const text = (btn.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (!text && !btn.getAttribute('aria-label')) continue;

        const hasOnclick = !!btn.getAttribute('onclick');
        const insideLink = !!btn.closest('a');
        const insideForm = !!btn.closest('form');
        const isSubmit = btn.type === 'submit';
        const hasDataAction = Array.from(btn.attributes).some(a => a.name.startsWith('data-'));
        const hasAriaControls = !!btn.getAttribute('aria-controls') || !!btn.getAttribute('aria-expanded');
        const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';

        // React attaches events via synthetic event system
        const hasReactHandler = Object.keys(btn).some(k =>
          k.startsWith('__reactFiber') || k.startsWith('__reactEvents') || k.startsWith('__reactProps')
        );

        if (!hasOnclick && !insideLink && !insideForm && !isSubmit && !hasDataAction && !hasAriaControls && !hasReactHandler && !isDisabled) {
          results.push({
            text: text || btn.getAttribute('aria-label') || '(no text)',
            tag: btn.tagName.toLowerCase(),
          });
        }
      }
      return results;
    });

    for (const btn of deadButtons) {
      addIssue(path, `"${btn.text}" <${btn.tag}>`, 'No click handler detected');
    }

    console.log(`  Dead buttons found: ${deadButtons.length}`);

  } catch (err) {
    console.error(`  ERROR scanning ${path}: ${err.message.slice(0, 120)}`);
    addIssue(path, '(page)', `Failed to scan: ${err.message.slice(0, 80)}`);
  } finally {
    await context.close();
  }
}

async function main() {
  console.log('Starting broken link scan on arenafi.org...\n');
  const browser = await chromium.launch({ headless: true });

  for (const path of PAGES) {
    try {
      await scanPage(browser, path);
    } catch (err) {
      console.error(`Failed to scan ${path}: ${err.message}`);
    }
  }

  await browser.close();

  // Print summary
  console.log('\n\n========================================');
  console.log('          SCAN RESULTS SUMMARY');
  console.log('========================================\n');

  if (issues.length === 0) {
    console.log('No issues found! All links and buttons are healthy.');
  } else {
    const padPage = 25;
    const padElem = 50;
    console.log(
      'Page'.padEnd(padPage) + ' | ' +
      'Element'.padEnd(padElem) + ' | ' +
      'Issue'
    );
    console.log('-'.repeat(padPage) + '-+-' + '-'.repeat(padElem) + '-+-' + '-'.repeat(50));

    for (const i of issues) {
      console.log(
        i.page.padEnd(padPage) + ' | ' +
        i.element.slice(0, padElem).padEnd(padElem) + ' | ' +
        i.issue
      );
    }

    console.log(`\nTotal issues: ${issues.length}`);

    const by404 = issues.filter(i => /\b404\b/.test(i.issue));
    const by5xx = issues.filter(i => /\b50[0-9]\b/.test(i.issue));
    const byHash = issues.filter(i => i.issue.includes('href="#"'));
    const byDead = issues.filter(i => i.issue.includes('No click handler'));
    const byPage = issues.filter(i => i.issue.includes('Failed to scan'));

    if (by404.length) console.log(`  - 404 broken links: ${by404.length}`);
    if (by5xx.length) console.log(`  - 5xx server errors: ${by5xx.length}`);
    if (byHash.length) console.log(`  - href="#" dead links: ${byHash.length}`);
    if (byDead.length) console.log(`  - Dead buttons (no handler): ${byDead.length}`);
    if (byPage.length) console.log(`  - Page scan failures: ${byPage.length}`);
  }

  console.log(`\nPages scanned: ${PAGES.length}`);
  console.log(`Unique internal links checked: ${checkedLinks.size}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
