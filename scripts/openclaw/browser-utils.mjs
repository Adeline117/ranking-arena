/**
 * Shared Chrome/Puppeteer lifecycle utilities for Mac Mini fetchers.
 *
 * Single source of truth for:
 * - Launch config (headless mode, args, anti-detection)
 * - Retry logic with orphan process cleanup
 * - Safe close with timeout + SIGKILL fallback
 *
 * Used by: fetch-phemex, fetch-lbank, fetch-blofin
 */

import puppeteer from 'puppeteer'
import { execSync } from 'child_process'

// ── Constants ──

export const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const LAUNCH_TIMEOUT_MS = 30000
const CLOSE_TIMEOUT_MS = 10000
const DEFAULT_MAX_RETRIES = 3

// ── Orphan cleanup ──

/** Kill orphan headless Chrome from previous cron runs (not user Chrome) */
export function killOrphanChromeProcesses() {
  try {
    const out = execSync(`pgrep -f 'Google Chrome.*--headless' 2>/dev/null || true`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim()
    if (out) {
      const pids = out.split('\n').filter(Boolean)
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGKILL')
        } catch {}
      }
      console.log(`  [cleanup] Killed ${pids.length} orphan headless Chrome process(es)`)
    }
  } catch {}
}

// ── Launch with retry ──

export async function launchBrowser(maxRetries = DEFAULT_MAX_RETRIES) {
  killOrphanChromeProcesses()

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: CHROME_PATH,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--window-size=1440,900',
          '--disable-blink-features=AutomationControlled',
        ],
        timeout: LAUNCH_TIMEOUT_MS,
      })
      await browser.version() // validate WS connection is alive
      return browser
    } catch (err) {
      console.warn(`  [launch] Attempt ${attempt}/${maxRetries} failed: ${err.message}`)
      if (attempt < maxRetries) {
        killOrphanChromeProcesses()
        await new Promise((r) => setTimeout(r, 3000 * attempt))
      } else {
        throw err
      }
    }
  }
}

// ── Safe close ──

export async function closeBrowser(browser) {
  if (!browser) return
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('close timeout')), CLOSE_TIMEOUT_MS)
      ),
    ])
  } catch {
    const proc = browser.process()
    if (proc) {
      proc.kill('SIGKILL')
      console.warn('  [cleanup] Force-killed Chrome process')
    }
  }
}

// ── Convenience: create page with standard config ──

export async function createPage(browser) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  )
  return page
}
